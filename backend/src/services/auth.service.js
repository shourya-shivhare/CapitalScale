import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';

import {
  findSMEByEmail, findSMEById, createSMEUser, updateSMELastLogin,
  findBankAdminByEmail, findBankAdminById, createBankAdminUser, updateBankAdminLastLogin,
  findRoleByName,
} from '../db/queries/users.queries.js';
import { createOtp, deleteOtpsByUserContact, findOtp, incrementOtpAttempts, deleteOtp } from '../db/queries/otps.queries.js';
import { recordAuditLog } from '../db/queries/auditLogs.queries.js';
import {
  generateAccessToken, generateRefreshToken, verifyRefreshToken,
  buildTokenPayload, sanitizeUser, generateMfaToken, verifyMfaToken,
  hashOtpCode, verifyOtpCode,
} from '../utils/token.utils.js';
import { ApiError } from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import {
  setSession, getSession, deleteSession,
  blacklistToken, isTokenBlacklisted,
  acquireOtpLock, releaseOtpLock,
  incrementFailedAttempts, getFailedAttempts, clearFailedAttempts,
} from '../config/redis.js';
import { publishEvent } from '../notifications/index.js';
import { NOTIFICATION_EVENTS } from '../notifications/events/notificationEvents.js';




/**
 * Generate a 6-digit OTP, hash it, persist the HASH (never plaintext),
 * and return the raw code so it can be delivered to the user (e.g. via email).
 *
 * BUG-04 FIX:
 *   1. The OTP code is no longer logged in plaintext.
 *   2. Only the HMAC-SHA256 hash of the code is stored in the database.
 *      An attacker with DB read access cannot recover the original code.
 */
const sendMfaOtp = async (userId, email) => {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await deleteOtpsByUserContact(userId, email);
  // Store the hash — never the plaintext code
  const codeHash = hashOtpCode(code);
  await createOtp({ user_id: userId, contact: email, code: codeHash, expiresInMs: 5 * 60 * 1000 });

  // Fire-and-forget: publish to OTP queue for async email delivery
  publishEvent(NOTIFICATION_EVENTS.AUTH_OTP_SEND, {
    userId, email, code, expiresInMinutes: 5,
  }).catch((err) => logger.error(`[OTP Publish] Failed: ${err.message}`));
  return code;
};



export const registerSME = async (data, _ipAddress, _userAgent) => {
  const { full_name, business_name, phone, email, password, address } = data;

  const existing = await findSMEByEmail(email);
  if (existing) { throw ApiError.conflict('An account with this email already exists'); }

  const role = await findRoleByName('sme_applicant');
  if (!role) { throw ApiError.internal('Default role not found. Please run database migration.'); }

  const password_hash = await argon2.hash(password);

  const user = await createSMEUser({ full_name, business_name, phone, email, password_hash, role_id: role.id, address });

  logger.info(`SME registered: ${email}`);

  await sendMfaOtp(user.id, email);
  const tempToken = generateMfaToken({ id: user.id, email, role: 'sme' });

  return { mfaRequired: true, tempToken, user: sanitizeUser(user, 'sme') };
};

export const loginSME = async ({ email, password }, ipAddress, userAgent) => {
  const attempts = await getFailedAttempts(email, ipAddress);
  if (attempts >= 5) { throw ApiError.tooManyRequests('Account locked due to too many failed attempts. Try again in 15 minutes.'); }

  const user = await findSMEByEmail(email, true);
  if (!user) { throw ApiError.unauthorized('Invalid email or password'); }
  if (!user.is_active) { throw ApiError.forbidden('Your account has been deactivated. Contact support.'); }

  const isMatch = await argon2.verify(user.password_hash, password);
  if (!isMatch) {
    await incrementFailedAttempts(email, ipAddress);
    throw ApiError.unauthorized('Invalid email or password');
  }

  await clearFailedAttempts(email, ipAddress);
  await updateSMELastLogin(user.id);

  const payload = buildTokenPayload(user, 'sme');
  const jti = uuidv4();
  const accessToken  = generateAccessToken(payload, jti);
  const refreshToken = generateRefreshToken({ id: user.id }, jti);
  await setSession(jti, { userId: user.id, email: user.email, role: 'sme', ipAddress, userAgent, createdAt: new Date() });

  logger.info(`SME logged in: ${email}`);
  return { user: sanitizeUser(user, 'sme'), accessToken, refreshToken };
};



export const registerBankAdmin = async (data) => {
  const { bank_name, branch_name, branch_address, ifsc_code, admin_name, email, phone, password } = data;

  const existing = await findBankAdminByEmail(email);
  if (existing) { throw ApiError.conflict('An account with this email already exists'); }

  const role = await findRoleByName('bank_underwriter');
  if (!role) { throw ApiError.internal('Default role not found. Please run database migration.'); }

  const password_hash = await argon2.hash(password);

  const user = await createBankAdminUser({ bank_name, branch_name, branch_address, ifsc_code, admin_name, email, phone, password_hash, role_id: role.id });

  logger.info(`Bank admin registered: ${email}`);

  await sendMfaOtp(user.id, email);
  const tempToken = generateMfaToken({ id: user.id, email, role: 'bank_admin' });

  return { mfaRequired: true, tempToken, user: sanitizeUser(user, 'bank_admin') };
};

export const loginBankAdmin = async ({ email, password }, ipAddress) => {
  const attempts = await getFailedAttempts(email, ipAddress);
  if (attempts >= 5) { throw ApiError.tooManyRequests('Account locked due to too many failed attempts. Try again in 15 minutes.'); }

  const user = await findBankAdminByEmail(email, true);
  if (!user) { throw ApiError.unauthorized('Invalid email or password'); }
  if (!user.is_active) { throw ApiError.forbidden('Your account has been deactivated. Contact support.'); }

  const isMatch = await argon2.verify(user.password_hash, password);
  if (!isMatch) {
    await incrementFailedAttempts(email, ipAddress);
    throw ApiError.unauthorized('Invalid email or password');
  }

  await clearFailedAttempts(email, ipAddress);
  await updateBankAdminLastLogin(user.id);

  const payload = buildTokenPayload(user, 'bank_admin');
  const jti = uuidv4();
  const accessToken  = generateAccessToken(payload, jti);
  const refreshToken = generateRefreshToken({ id: user.id }, jti);
  await setSession(jti, { userId: user.id, email: user.email, role: 'bank_admin', ipAddress, userAgent, createdAt: new Date() });

  logger.info(`Bank admin logged in: ${email}`);
  return { user: sanitizeUser(user, 'bank_admin'), accessToken, refreshToken };
};



export const verifyMfaOTP = async (tempToken, code, ipAddress, userAgent) => {
  if (!tempToken || !code) { throw ApiError.badRequest('MFA token and verification code are required'); }

  let decoded;
  try { decoded = verifyMfaToken(tempToken); }
  catch { throw ApiError.unauthorized('Invalid or expired MFA session'); }

  const { id, email, role } = decoded;

  // BUG-10 FIX: Acquire a per-user distributed Redis lock before verification.
  // This prevents concurrent requests from racing past the attempt counter,
  // which could allow brute-forcing past the 3-attempt lockout.
  const lockAcquired = await acquireOtpLock(id);
  if (!lockAcquired) {
    throw ApiError.tooManyRequests('A verification attempt is already in progress. Please wait a moment.');
  }

  try {
    const otp = await findOtp({ user_id: id, contact: email });
    if (!otp) { throw ApiError.notFound('No verification request found. Please login again.'); }

    if (otp.expires_at < new Date()) {
      await deleteOtp(otp.id);
      throw ApiError.badRequest('Verification code has expired. Please login again.');
    }

    // BUG-04 FIX: Compare hashed codes using constant-time comparison.
    // verifyOtpCode uses HMAC-SHA256 + timingSafeEqual — no plaintext comparison.
    const isMatch = verifyOtpCode(code, otp.code);
    if (!isMatch) {
      await incrementOtpAttempts(otp.id);
      if (otp.attempts + 1 >= 3) {
        await deleteOtp(otp.id);
        throw ApiError.badRequest('Too many failed attempts. Please login again.');
      }
      throw ApiError.badRequest('Invalid verification code');
    }

    await deleteOtp(otp.id);

    let user;
    if (role === 'sme') {
      user = await findSMEById(id);
    } else {
      user = await findBankAdminById(id);
    }

    if (!user || !user.is_active) { throw ApiError.unauthorized('User not found or account is inactive'); }

    if (role === 'sme') { await updateSMELastLogin(id); }
    else { await updateBankAdminLastLogin(id); }

    const payload = buildTokenPayload(user, role);
    const jti = uuidv4();
    const refreshToken = generateRefreshToken({ id: user.id }, jti);
    const accessToken  = generateAccessToken(payload, jti);

    await setSession(jti, { userId: user.id, email: user.email, role, ipAddress, userAgent, createdAt: new Date() });

    logger.info(`MFA verified. User logged in: ${email}`);
    return { user: sanitizeUser(user, role), accessToken, refreshToken };

  } finally {
    // Always release the lock — even if an error is thrown above.
    await releaseOtpLock(id);
  }
};



export const refreshAccessToken = async (refreshToken, ipAddress, userAgent) => {
  if (!refreshToken) { throw ApiError.unauthorized('Refresh token is required'); }

  let decoded;
  try { decoded = verifyRefreshToken(refreshToken); }
  catch { throw ApiError.unauthorized('Invalid or expired refresh token'); }

  const { id, jti } = decoded;

  const isBlacklisted = await isTokenBlacklisted(jti);
  if (isBlacklisted) {
    recordAuditLog({ actor_id: id, action: 'security.token_reuse_fraud', status: 'failure', ip_address: ipAddress, metadata: { reason: 'Refresh token reuse' } });
    throw ApiError.unauthorized('Security alert: Token reuse detected. Please log in again.');
  }

  const session = await getSession(jti);
  if (!session) { throw ApiError.unauthorized('Session has expired. Please log in again.'); }

  await blacklistToken(jti);
  await deleteSession(jti);

  let user = await findSMEById(id);
  let type = 'sme';
  if (!user) { user = await findBankAdminById(id); type = 'bank_admin'; }
  if (!user || !user.is_active) { throw ApiError.unauthorized('User not found or account is inactive'); }

  const newJti         = uuidv4();
  const newRefreshToken = generateRefreshToken({ id: user.id }, newJti);
  const newAccessToken  = generateAccessToken(buildTokenPayload(user, type), newJti);
  await setSession(newJti, { userId: user.id, email: user.email, role: type, ipAddress, userAgent, createdAt: new Date() });

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
};



export const logout = async (accessTokenPayload) => {
  if (accessTokenPayload?.sessionId) {
    await deleteSession(accessTokenPayload.sessionId);
    await blacklistToken(accessTokenPayload.sessionId);
  }
  return true;
};
