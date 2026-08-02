import { createWorkerChannel, QUEUES } from '../../config/rabbitmq.js';
import { renderTemplate } from '../templates/index.js';
import { sendEmail } from '../services/emailSender.service.js';
import { acquireEmailSlot } from '../services/rateLimiter.service.js';
import supabase from '../../db/supabaseClient.js';
import logger from '../../utils/logger.js';
import { NOTIFICATION_EVENTS } from '../events/notificationEvents.js';

let _channel = null;

const trackEmailJob = async (message, status, errorMsg = null) => {
  try {
    await supabase.from('email_jobs').upsert({
      correlation_id: message.correlationId,
      recipient: message.payload?.email || message.payload?.to || 'unknown',
      template: message.eventType,
      payload: message.payload,
      status,
      retry_count: message.retryCount || 0,
      error_message: errorMsg,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'correlation_id' });
  } catch (err) {
    logger.error(`[OTP Worker] Failed to track job state: ${err.message}`);
  }
};

export const startOTPWorker = async () => {
  try {
    _channel = await createWorkerChannel();

    _channel.consume(QUEUES.OTP, async (msg) => {
      if (!msg) return;

      let messageData;
      try {
        messageData = JSON.parse(msg.content.toString());
      } catch (err) {
        logger.error(`[OTP Worker] Invalid JSON format. Discarding message.`);
        _channel.ack(msg);
        return;
      }

      const { correlationId, eventType, payload, retryCount = 0 } = messageData;

      try {
        // trackEmailJob is best-effort — don't let a missing table crash the worker
        try { await trackEmailJob(messageData, 'processing'); } catch (trackErr) {
          logger.warn(`[OTP Worker] email_jobs tracking skipped: ${trackErr.message}`);
        }

        // Check rate limit (uses reserved OTP bucket)
        const { allowed, resetInMs } = await acquireEmailSlot('otp');
        
        if (!allowed) {
          logger.warn(`[OTP Worker] Rate limited. Requeueing message ${correlationId}. Retry in ${resetInMs}ms`);
          // NACK and requeue immediately — RabbitMQ will re-deliver. 
          // For a true delay, a delayed-message plugin is better, but since prefetch=1, 
          // we can just sleep the worker thread to hold the message back.
          await new Promise(r => setTimeout(r, Math.min(resetInMs, 5000)));
          _channel.nack(msg, false, true); 
          return;
        }

        // Render HTML
        const emailContent = renderTemplate(eventType, payload);
        if (!emailContent) {
          throw new Error(`No template found for event ${eventType}`);
        }

        // Send Email
        await sendEmail({
          to: payload.email,
          subject: emailContent.subject,
          html: emailContent.html,
          correlationId,
          retryCount,
          maxRetries: 10
        });

        // Success
        try { await trackEmailJob(messageData, 'sent'); } catch (_) {}
        _channel.ack(msg);
        logger.info(`[OTP Email Sent] To: ${payload.email} | Event: ${eventType} | ID: ${correlationId}`);

      } catch (err) {
        logger.error(`[OTP Worker] FULL ERROR for ${correlationId}:`, err);
        logger.error(`[OTP Worker] Stack: ${err.stack}`);
        
        messageData.retryCount = retryCount + 1;
        await trackEmailJob(messageData, 'failed', err.message);

        if (messageData.retryCount > 10) {
          logger.error(`[OTP Worker] Max retries (10) exceeded for ${correlationId}. Rejecting (to DLQ).`);
          _channel.nack(msg, false, false); // requeue=false moves it to DLX/DLQ
        } else {
          // Requeue for retry. Because we are prefetch=1, we don't want to block the whole queue with sleep.
          // In RabbitMQ, best practice for backoff without plugins is to reject to DLX with TTL, 
          // but for simplicity here we just NACK and let it re-deliver.
          // To prevent tight loops, we sleep 2s.
          await new Promise(r => setTimeout(r, 2000));
          
          // Actually, we must update the message payload with the new retryCount, so we ack the old and publish new
          _channel.ack(msg);
          _channel.publish(
             msg.fields.exchange, 
             msg.fields.routingKey, 
             Buffer.from(JSON.stringify(messageData)),
             { priority: 10 }
          );
        }
      }
    });

    logger.info(`✅ OTP Worker started listening on queue: ${QUEUES.OTP}`);
  } catch (err) {
    logger.error(`❌ OTP Worker failed to start: ${err.message}`);
  }
};
