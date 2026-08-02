# CapitalScale — Interview Preparation Guide

> A complete, interview-ready deep-dive into the three most complex technical pillars of CapitalScale: Authentication, Notifications, and the RAG Pipeline — plus a general architectural overview.

---

## Part 1: General Project Architectural Overview

### What is CapitalScale?

CapitalScale is a production-grade, AI-powered SME (Small & Medium Enterprise) loan underwriting platform. It solves a real problem: banks manually reviewing loan applications is slow, error-prone, and inconsistent. CapitalScale automates this by:

1. **Extracting text** from uploaded financial documents (PDFs, images) using OCR
2. **Parsing structured financial parameters** (turnover, DSCR, credit score, etc.) from that text using an LLM
3. **Evaluating those parameters** against the bank's specific underwriting policy rules using another LLM pass
4. **Communicating decisions** back to both the Bank Admin and the SME applicant via real-time notifications

### The Three-Tier Monorepo Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (React 18 + Vite)           Port: 3000                │
│  ─ Zustand auth state (token in-memory, user in localStorage)   │
│  ─ NotificationContext (SSE + REST polling hybrid)              │
│  ─ Axios interceptor (auto-refresh on 401)                      │
└─────────────────────┬────────────────────────────────────────────┘
                      │  HTTP REST + SSE
┌─────────────────────▼────────────────────────────────────────────┐
│  BACKEND (Node.js + Express.js)       Port: 5000                │
│  ─ JWT + Redis Hybrid Auth            RabbitMQ Notification Bus  │
│  ─ Business Logic (Loans, Banks, OCR, Extraction, Underwriting) │
│  ─ SSE Manager (Redis Pub/Sub for multi-instance sync)          │
└─────────────────────┬────────────────────────────────────────────┘
                      │  HTTP REST (internal secret header)
┌─────────────────────▼────────────────────────────────────────────┐
│  AI SERVICES (Python FastAPI)         Port: 5001                │
│  ─ PaddleOCR + pdfplumber → Domain-aware chunking → pgvector    │
│  ─ Gemini LLM (extraction, underwriting, chat)                  │
│  ─ CrossEncoder re-ranker for RAG quality                       │
└──────────────────────────────────────────────────────────────────┘

INFRASTRUCTURE:
  PostgreSQL (Supabase) — primary data store + pgvector extension
  Redis               — sessions, token blacklist, SSE Pub/Sub, email rate limit
  RabbitMQ (CloudAMQP)— async notification event bus
  Cloudinary          — document file storage
```

### Key Architectural Decisions

| Decision                         | The "Why" (Interview Answer)                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Three-tier separation**        | Node.js excels at I/O-heavy HTTP but is terrible at CPU-intensive ML. FastAPI + asyncio handles concurrent AI workloads naturally. Separating them lets each scale independently.             |
| **Monorepo with npm workspaces** | Single repo for all tiers simplifies CI/CD; developers see the entire system; no version drift between services.                                                                              |
| **Supabase + asyncpg**           | Backend uses Supabase JS SDK for convenience; Python AI service uses asyncpg directly for raw async performance — no ORM overhead for high-throughput embedding inserts.                      |
| **Sequential processing queue**  | LLM providers have rate limits. A sequential queue guarantees we never burst past quota and provides deterministic ordering — a retry-able job doesn't block others, it gets priority-queued. |
| **RabbitMQ for notifications**   | Decouples business services from email delivery. If SMTP is slow or down, the loan status transition still completes instantly; the email delivery retries independently.                     |

---

## Part 2: Authentication — Complete Working Explanation

"Our authentication uses a hybrid model. We issue JWTs for stateless authentication but back them with Redis sessions so tokens can be revoked instantly. Login is a two-phase MFA process: first we verify the password with Argon2, then generate a one-time password. We never store the OTP in plaintext; we store an HMAC-SHA256 hash of it. OTP delivery is asynchronous through RabbitMQ, where an OTP worker sends the email via SMTP, keeping the login API fast. After password verification we return a short-lived MFA token with its own JWT secret and audience. Only after successful OTP verification do we issue the access token, refresh token, and create the Redis session. Using separate JWT secrets and audience claims for access, refresh, and MFA tokens prevents cross-token substitution attacks."

### High-Level Summary

CapitalScale uses a **Hybrid Authentication Model**: stateless JWTs for fast per-request verification, backed by stateful Redis sessions for instant revocation. A mandatory two-phase MFA flow ensures that stolen passwords alone cannot grant access.

### The 3-Secret JWT Architecture (Critical Security Point)

Most systems use one JWT secret. CapitalScale uses **three distinct secrets**, each with a unique `audience` claim:

```
JWT_SECRET           → audience: "capitalscale:access"   (2h expiry)
JWT_REFRESH_SECRET   → audience: "capitalscale:refresh"  (30d expiry, HttpOnly cookie)
JWT_MFA_SECRET       → audience: "capitalscale:mfa"      (5m expiry)
```

**Why this matters in an interview:** An attacker who steals the MFA temp token cannot use it as an access token — `verifyAccessToken()` checks `audience: "capitalscale:access"`, not `"capitalscale:mfa"`. Cross-token substitution attacks are structurally impossible.

### Phase 1: Login (Credential Verification)

```
Client                   Backend                 RabbitMQ                SMTP
  │                         │                        │                     │
  │── POST /auth/sme/login ─▶│                        │                     │
  │                         │── argon2.verify() ─────│                     │
  │                         │── Generate 6-digit OTP │                     │
  │                         │── hashOtpCode()         │                     │
  │                         │   HMAC-SHA256(code,     │                     │
  │                         │   JWT_MFA_SECRET)        │                     │
  │                         │── Store HASH in DB      │                     │
  │                         │── publishEvent(          │                     │
  │                         │   AUTH_OTP_SEND,        │                     │
  │                         │   priority:10) ─────────▶                     │
  │                         │                        │── otpWorker         │
  │                         │                        │   consumes ─────────▶
  │                         │── generateMfaToken()    │                     │
  │◀── { mfaRequired:true,  │                        │                     │
  │      tempToken }        │                        │                     │
```

**Key points:**

- Password verified with **Argon2id** (memory-hard — GPU attacks require enormous RAM)
- OTP is **only stored as HMAC-SHA256 hash** — DB breach cannot reveal OTP codes
- OTP email dispatched via **RabbitMQ** (fire-and-forget, not blocking the HTTP response)
- Response contains only a temp token — no session created yet

### Phase 2: MFA Verification (Session Creation)

```
Client                   Backend                    Redis
  │                         │                          │
  │── POST /auth/mfa/verify ▶│                          │
  │   { tempToken, code }   │                          │
  │                         │── verifyMfaToken(token)  │
  │                         │   (audience: mfa check)  │
  │                         │                          │
  │                         │── acquireOtpLock(userId) ▶
  │                         │   SET NX EX 15           │
  │                         │   (distributed mutex)    │
  │                         │                          │
  │                         │── verifyOtpCode(input,   │
  │                         │   stored_hash)           │
  │                         │   timingSafeEqual()      │
  │                         │                          │
  │                         │── Generate UUID JTI      │
  │                         │── generateAccessToken()  │
  │                         │── generateRefreshToken() │
  │                         │── setSession(jti, data) ─▶
  │                         │── releaseOtpLock() ───────▶
  │                         │                          │
  │◀── { accessToken, user }│                          │
  │    Set-Cookie:           │                          │
  │    refreshToken          │                          │
  │    (httpOnly, secure)    │                          │
```

**Three layers of OTP security:**

1. **HMAC hash** — plaintext never stored
2. **Redis distributed lock** — only one concurrent verification per user (prevents race-condition brute force that bypasses 3-attempt counter)
3. **timingSafeEqual** — constant-time comparison prevents timing side-channel attacks

### Phase 3: API Request Authentication

Every protected API call:

1. Client sends `Authorization: Bearer <accessToken>`
2. `protect` middleware: `verifyAccessToken(token)` — cryptographic signature check + audience assertion
3. `getSession(decoded.sessionId)` — checks Redis for active session
4. **If Redis is down:** `isTokenBlacklisted()` returns `true` (fail-safe deny) — attackers cannot exploit a Redis outage to reuse revoked tokens
5. Attaches `req.user = decoded` → `authorizeRoles()` checks role

> **Interview gotcha:** "Why do you need Redis if JWT is already stateless?"
> **Answer:** Without Redis, you cannot revoke a token before it expires. When a user logs out or gets deactivated, the JWT is still valid for up to 2 hours. The Redis session lookup makes instant revocation possible.

### Phase 4: Token Refresh (Rotation with Fraud Detection)

```
Refresh Token (old JTI)
        │
        ▼
verifyRefreshToken() + audience check
        │
        ▼
isTokenBlacklisted(jti)?
    YES → Log security.token_reuse_fraud audit event → 401 Reject
    NO  ↓
getSession(jti)?
    NULL → Session expired → 401
    OK   ↓
blacklistToken(oldJti) + deleteSession(oldJti)
        │
        ▼
Generate newJti + new Access Token + new Refresh Token
        │
setSession(newJti)  →  Set-Cookie: newRefreshToken  →  Return newAccessToken
```

**Token reuse detection:** If a refresh token was already rotated (meaning the old token was stolen and used), the old JTI will be in the blacklist. This triggers a security audit event — the legitimate user's next refresh will fail until they re-login.

### Phase 5: Idle Timeout & Frontend Security

`useIdleTimeout` hook watches browser events (mousemove, keydown, scroll). After **15 minutes** of inactivity, it calls `logout()`, clearing the Zustand store and localStorage. This protects unattended browser sessions.

### Security Hardening Summary

| Attack Vector                  | Defense                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| Stolen password                | Argon2id hashing + mandatory MFA                           |
| Stolen OTP                     | 5-minute expiry + 3-attempt lockout + HMAC hash in DB      |
| OTP brute-force race condition | Redis distributed lock (SET NX)                            |
| DB read reveals OTP            | Stored as HMAC-SHA256, not plaintext                       |
| Cross-token JWT substitution   | Audience claims on all 3 token types                       |
| Refresh token reuse (theft)    | JTI blacklisting + reuse fraud alert                       |
| Redis outage token replay      | Fail-safe deny (return true on Redis down)                 |
| XSS token theft                | Access token in memory only; refresh token HttpOnly cookie |
| CSRF                           | SameSite cookie attribute + short expiry                   |
| Brute force login              | Rate limiter: 10 req/15min on auth endpoints               |
| Internal webhook abuse         | x-internal-secret header validation                        |

---

## Part 3: Notification System — Complete Working Explanation

### Architecture Overview

```
Business Event (e.g., loan status change)
    │
    ▼
publishEvent(eventType, payload, { priority })
    │
    ▼  [RabbitMQ topic exchange: capitalscale.notifications]
    ├── otp.*  → otp_queue (priority:10, DLX-bound)  → otpWorker
    └── loan.* → notification_queue (priority:5, DLX-bound) → emailWorker
                                                              │
                                              ┌──────────────┤
                                              ▼              ▼
                                      In-App Notification   Email (if applicable)
                                              │
                                              ▼
                                      Persist to notifications table
                                              │
                                              ▼
                                      publishSSEEvent(userId, data)
                                              │
                                              ▼
                                      Redis PUBLISH sse:user:<userId>
                                              │
                                      ┌───────┴───────┐
                                      ▼               ▼
                              Server Instance A  Server Instance B
                              (holds SSE conn)   (no conn for this user)
                                      │
                                      ▼
                              EventSource.onmessage → React state update
```

### RabbitMQ Topology (Why designed this way)

```javascript
// Exchange: topic type allows routing key pattern matching
Exchange: 'capitalscale.notifications' (topic, durable)
├── 'otp.#'  binding → otp_queue  (x-max-priority: 10)
└── 'loan.#' binding → notification_queue (x-max-priority: 5)

// Dead Letter Exchange for failed messages
Exchange: 'capitalscale.dlx' (direct)
└── 'dlq' binding → dead_letter_queue
```

**Why topic exchange?** As the system grows, new event types (e.g., `bank.policy.updated`) can be routed to new queues without changing publisher code — just add a new binding.

**Why two separate queues?** OTPs are time-critical (5-minute expiry). If a burst of loan status emails causes queue backlog, OTPs would be stuck behind them. Separate queues with higher priority for OTPs guarantee OTPs are never delayed by general notification load.

### Worker Processing Logic (emailWorker.js)

For every message on `notification_queue`:

1. **Parse & track** — JSON parse message; upsert to `email_jobs` with status `processing`
2. **In-app first** — for `loan.status.*` events, persist notification to DB + push SSE (fast, no external API)
3. **Email gating** — only `missing_info`, `approved`, `rejected` statuses trigger emails (defined in `SME_EMAIL_STATUSES`)
4. **Rate limit check** — `acquireEmailSlot('general')` — Redis sliding window ensures we don't blast SMTP
5. **Render template** — `renderTemplate(eventType, payload)` returns `{ subject, html }`
6. **Send email** — nodemailer SMTP delivery
7. **Retry logic** — On failure: `retryCount++`, sleep 2s, re-publish message. After 10 retries: `nack(false, false)` → RabbitMQ dead-letters to DLQ

### SSE + Redis Pub/Sub (Multi-instance Real-time)

**The problem:** In production, there may be multiple Node.js instances behind a load balancer. User A is connected via SSE to Instance 1. A loan event fires and triggers `publishSSEEvent()` on Instance 2. Without coordination, Instance 2 can't reach User A's SSE connection.

**The solution:**

```
Instance 2 calls:
  publishSSEEvent(userId, data)
      │
      ▼
  redisClient.publish('sse:user:<userId>', JSON.stringify(data))
      │
      ▼
  Redis broadcasts to ALL subscribers of that channel
      │
      ├─ Instance 1 (has SSE connection for userId)
      │       │
      │       ▼
      │   _pushToLocalConnections(userId, data)
      │       │
      │       ▼
      │   res.write(`data: ${JSON.stringify(data)}\n\n`)
      │       │
      │       ▼
      │   Client EventSource.onmessage fires
      │
      └─ Instance 2 (no connection — ignores it)
```

**Frontend (NotificationContext.jsx) — Three-layer resilience:**

1. **On login** — immediate REST fetch to catch missed notifications
2. **SSE EventSource** — `GET /api/v1/notifications/sse?token=<accessToken>` (token as query param because `EventSource` cannot set custom headers)
3. **30s polling fallback** — `setInterval(fetchNotifications, 30000)` catches any silent SSE connection drops

### Email Rate Limiting (rateLimiter.service.js)

Redis sliding window per minute:

```
email:ratelimit:otp:{minute_epoch}     → OTP bucket (reserved slots)
email:ratelimit:general:{minute_epoch} → General email bucket

Total limit: EMAIL_RATE_LIMIT_PER_MINUTE (default 60)
OTP reserve: OTP_RATE_RESERVE (default 10)
General max: 60 - 10 = 50 emails/min
```

**Atomic pattern:** `INCR key` + check count vs limit + `EXPIRE key 61`. If over limit: `DECR key` (rollback) and return `{ allowed: false }`.

---

## Part 4: RAG Pipeline — Complete Working Explanation

### What is RAG and why does CapitalScale need a custom one?

Standard RAG (Retrieve, Augment, Generate) retrieves relevant text chunks from a vector database and feeds them to an LLM as context. Generic implementations use tools like LangChain's `RecursiveCharacterTextSplitter` — which splits text every N characters.

**Why generic chunking fails for financial documents:**

- A bank statement row: `"2024-01-15 | Vendor Payment | -₹45,230"` split in half becomes meaningless
- A bank policy: `"Minimum DSCR: 1.25. Exception: For MSMEs under CGTSME scheme, 1.10 is acceptable."` — if "Exception" lands in a different chunk, the LLM will wrongly reject eligible applicants

CapitalScale's RAG is **domain-aware and deterministic**.

### Pipeline Stage 1: Document Loading (`services/ocr/`)

```python
# document_loader.py — Strategy Pattern (Open/Closed Principle)
async def process_document(file_bytes, filename, mime_type) -> DocumentResult:
    if mime_type.startswith("image/"):
        extractor = PaddleOcrExtractor()
    elif mime_type == "application/pdf":
        fallback = ScannedPdfOcrExtractor()  # PaddleOCR as fallback
        extractor = PdfPlumberExtractor(fallback_extractor=fallback)
    return await extractor.extract(file_bytes, filename)
```

**Native vs Scanned PDF detection:**

```python
avg_chars_per_page = native_chars / result.page_count
if avg_chars_per_page >= 50:
    result.pdf_type = "native"  # pdfplumber extracted successfully
else:
    # Fallback to PaddleOCR — it's a scanned image inside a PDF wrapper
    return await self.fallback_extractor.extract(file_bytes, filename)
```

**Why `asyncio.to_thread()` for pdfplumber?**
pdfplumber is synchronous and CPU-bound. Calling it directly in an async FastAPI handler would block the entire event loop — no other HTTP requests could be served for the 5 seconds it takes to parse a PDF. `asyncio.to_thread()` pushes it to the ThreadPoolExecutor.

### Pipeline Stage 2: Domain-Aware Chunking (`services/rag/chunking/`)

**The ChunkingStrategyFactory** selects the right algorithm based on document type:

**BankPolicySemanticStrategy (the most important one):**

```python
# 0 token overlap — structural integrity guarantees we don't need it
# Exception gluing — deterministically attaches caveats to parent rules

def _glue_exceptions(blocks):
    glued = []
    for block in blocks:
        first_word = block.lower().split()[0] if block.split() else ""
        if first_word in {"exception:", "note:", "however,", "provided"} and glued:
            glued[-1] += "\n" + block  # Attach to parent rule
        else:
            glued.append(block)
    return glued
```

**FinancialTableStrategy (for bank statements):**

```python
# group_table_rows detects tabular content and prevents mid-row splits
def group_table_rows(lines):
    # If a line contains | or \t or double-space: it's a table row
    # Keep grouping until we hit a non-table line
```

**Orphan merging:**
Any chunk < 40 tokens (`CARRY_FORWARD_MAX_TOKENS`) is merged into the next chunk. This prevents isolated page numbers, footnotes, or single-word lines from becoming their own vector embedding — which would pollute retrieval results.

### Pipeline Stage 3: Embedding & Storage

```python
# All embedding calls route through llm_facade.embed()
# This enforces the shared rate limiter — prevents quota exhaustion
embedding = await llm_facade.embed(chunk_text)  # 768-dim vector

# pgvector storage
await pgvector_service.store_chunks(chunks_with_embeddings)
```

**HNSW Index** (Hierarchical Navigable Small World):

```sql
CREATE INDEX idx_doc_emb_vector_hnsw ON document_embeddings
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

This gives approximate nearest-neighbor search in O(log n) instead of O(n) — critical for fast retrieval across millions of chunks.

### Pipeline Stage 4: Retrieval (`services/rag/retrieval_service.py`)

For underwriting, the system retrieves evidence for **6 standard financial questions** in parallel:

```python
UNDERWRITING_QUESTIONS = {
    "annual_revenue": { "text": "What is the annual revenue?", "document_types": ["balance_sheets", "itr"] },
    "cash_flow":      { "text": "What is the average monthly balance?", "document_types": ["bank_statements"] },
    "policy_compliance": { "text": "What are the loan eligibility rules?", "document_types": ["bank_policy"] },
    # ... 3 more questions
}
```

**Query Embedding Cache** — These 6 questions are embedded once and cached in `query_embedding_cache` PostgreSQL table. On every assessment, the system fetches cached vectors instead of calling the Gemini API 6 times.

**Contiguous chunk merging:**

```python
# If chunks 4, 5, 6 from the same page are retrieved separately,
# merge them back together before sending to LLM
if same_doc and same_page and curr_idx == prev_idx + 1:
    current_group.append(curr)
```

This gives the LLM unbroken context instead of fragmented snippets.

### Pipeline Stage 5: CrossEncoder Re-Ranking

```python
# reranker.py
async def rerank_chunks(self, query, chunks, top_k=3):
    # Prepare (query, chunk_text) pairs
    pairs = [[query, chunk["text"]] for chunk in chunks]

    # Run CrossEncoder.predict() in thread pool (blocking CPU-bound operation)
    scores = await asyncio.to_thread(model.predict, pairs)

    # Sort by ML relevance score
    reranked = sorted(chunks, key=lambda x: x["rerank_score"], reverse=True)
    return reranked[:top_k]
```

**Vector search (cosine distance)** is excellent at finding topically related chunks.
**CrossEncoder** evaluates the specific (query, chunk) pair and scores actual contextual relevance — catching cases where a chunk is topically adjacent but not answering the specific question.

**Why is this important for interviews?** It demonstrates knowledge that production RAG requires more than just "embed + cosine search." The two-stage retrieval pattern (broad vector → precise reranking) is a well-known industry best practice.

### Pipeline Stage 6: LLM Synthesis

Final context: merged, re-ranked chunks with provenance tags:

```
[Evidence Source: ITR_2023.pdf | Type: itr]
Annual Turnover (FY 2023): ₹2,40,00,000
Net Profit After Tax: ₹18,50,000

---

[Evidence Source: BankStatement_SBI.pdf | Type: bank_statements]
Average Monthly Balance (Jan-Jun 2024): ₹3,42,000
```

The LLM receives this structured, sourced context and generates the extraction result or underwriting decision — strictly grounded in the provided evidence.

---

## Part 5: Common Interview Questions & Answers

### Q: "Why did you use RabbitMQ instead of Redis Pub/Sub for notifications?"

**A:** Redis Pub/Sub is fire-and-forget — if the subscriber is down when a message is published, the message is lost. RabbitMQ is a proper message broker with persistence (`persistent: true`), acknowledgements (ACK/NACK), retry logic, and Dead Letter Queues. For OTP delivery, losing a message means the user cannot log in — that's unacceptable. RabbitMQ guarantees at-least-once delivery with the retry mechanism.

We do use Redis Pub/Sub — but for the SSE fan-out layer, where fire-and-forget is acceptable because SSE has its own reconnection mechanism and the client will catch up via REST polling.

### Q: "Your OCR approach buffers 50MB files in Node.js RAM. Doesn't that crash under load?"

**A:** Absolutely right — `multer.memoryStorage()` is a known MVP-era bottleneck. At scale, the correct architecture is: client requests a pre-signed Cloudinary/S3 URL from Node.js, uploads the 50MB file directly from the browser to object storage, and then triggers the Python AI service with just the file URL. Node.js never touches the binary bytes. I'd implement this using Cloudinary's direct upload API or AWS S3 pre-signed URLs in the production tier.

### Q: "How do you ensure the AI service callback endpoints aren't publicly exploitable?"

**A:** We use an `x-internal-secret` header (validated by `requireInternalSecret` middleware in Express). The Python AI service sends this shared secret on all backend callbacks. External actors don't know the secret. This was actually identified as a security gap in an earlier version — the `markVectorized` and extraction status endpoints were publicly accessible — and this guard was added as a fix.

### Q: "Why did you choose SSE over WebSockets for real-time notifications?"

**A:** Three reasons. First, notifications are unidirectional — server to client — so we don't need the bidirectional channel that WebSockets provide. Second, SSE works over standard HTTP/2, bypassing most corporate firewall issues that plague WebSocket upgrades. Third, SSE has native browser reconnection built in. The main challenge with SSE at scale is multi-instance state — we solved that with Redis Pub/Sub, so every server instance subscribes to user-specific channels and relays events to locally-connected clients.

### Q: "Why does the CrossEncoder run in `asyncio.to_thread()`?"

**A:** CrossEncoder.predict() is a synchronous, CPU/GPU-bound operation from sentence-transformers. FastAPI runs on a single asyncio event loop. If I called it directly without offloading, the event loop would freeze for the entire duration of the ML inference — every other incoming HTTP request would stall. `asyncio.to_thread()` pushes the blocking call to Python's ThreadPoolExecutor, keeping the event loop free to handle other concurrent requests while the ML model runs.

### Q: "What happens if Redis goes down entirely?"

**A:** Several things:

1. `isTokenBlacklisted()` returns `true` — all tokens are treated as potentially blacklisted (fail-safe deny). Users cannot make API calls until Redis recovers. This is the correct security posture — availability is sacrificed to prevent revoked token reuse.
2. `getSession()` returns `null` — the `protect` middleware throws 401 for all requests.
3. SSE Pub/Sub stops working — notifications become REST-polling only (30s interval fallback in `NotificationContext`).
4. Email rate limiting degrades gracefully — `acquireEmailSlot()` returns `{ allowed: true }` when Redis is unavailable.
5. OTP lock fails open — verification proceeds without distributed locking (still rate-limited at the HTTP level).

The system prioritizes security over availability for the authentication layer, and availability over security for the email rate limit layer — a conscious design tradeoff documented in the code comments.
