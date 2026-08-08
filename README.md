# Self-Hosted API Gateway with Rate Limiting

> B.Tech Final Year Project · Computer Science & Engineering  
> Node.js · Express · Redis · React · Docker

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Structure](#3-project-structure)
4. [Setup Instructions](#4-setup-instructions)
   - [Local Development](#41-local-development)
   - [Docker (Full Stack)](#42-docker-full-stack)
5. [API Reference](#5-api-reference)
   - [Key Management](#51-key-management)
   - [Protected Endpoints](#52-protected-endpoints)
   - [Analytics](#53-analytics)
6. [Load Testing](#6-load-testing)
7. [Design Decisions](#7-design-decisions)
8. [Running Tests](#8-running-tests)

---

## 1. Problem Statement

Public APIs must protect themselves from abuse — a single misbehaving
client can exhaust server resources and degrade service for everyone
else. Hosted solutions (AWS API Gateway, Kong, Apigee) solve this but
add cost, vendor lock-in, and a black box between you and your traffic.

This project implements a **self-hosted API gateway** that provides:

- **API-key authentication** — every request must carry a valid key; keys
  are issued per consumer and assigned a rate-limit tier.
- **Configurable rate limiting** — two algorithms (token bucket and sliding
  window counter) are available and selectable per key. Both run as atomic
  Lua scripts inside Redis, so the limit is enforced globally even when
  multiple gateway instances run behind a load balancer.
- **Structured request logging** — every authenticated request (allowed or
  blocked) is appended to a Redis Stream, recording timestamp, endpoint,
  decision, and latency.
- **Live analytics dashboard** — a React single-page application polls
  `/analytics` every five seconds and displays a requests-per-minute chart,
  an allowed-vs-blocked ratio, and a table of the top API consumers.

The system is designed to be **deployable as a Docker Compose stack** with
two app instances behind Nginx round-robin, demonstrating that Redis-backed
rate limiting holds globally — not per-instance.

---

## 2. Architecture Overview

```
                          ┌──────────────────────────────┐
Browser / curl            │         Docker network        │
   │                      │                               │
   ├─── :5173 ────────────►  dashboard (nginx)            │
   │                      │      │  /analytics proxy      │
   │                      │      ▼                        │
   └─── :8080 ────────────►  gateway (nginx)              │
                          │   round-robin upstream         │
                          │      │            │            │
                          │      ▼            ▼            │
                          │    app1         app2           │
                          │  :3001        :3002            │
                          │   (Express)   (Express)        │
                          │      │            │            │
                          │      └─────┬──────┘            │
                          │            ▼                   │
                          │          Redis                 │
                          │   rate-limit counters          │
                          │   + request log stream         │
                          └──────────────────────────────┘
```

### Request lifecycle (one request through `GET /api/ping`)

1. **Client** sends `GET /api/ping` with `X-API-Key: sk_xxx` to Nginx on port 8080.
2. **Nginx** picks `app1` or `app2` (round-robin) and forwards the request.
3. **`requestLogger` middleware** records `Date.now()` and attaches a `res.on('finish')` listener.
4. **`authenticate` middleware** looks up the key in the in-memory registry. Returns `401` if not found.
5. **`rateLimit` middleware** calls `limiter.tryConsume(key)`, which executes a Lua script in Redis atomically:
   - **Token bucket:** refills tokens proportional to elapsed time, then deducts one.
   - **Sliding window:** evicts timestamps older than the window, checks count, then inserts.
6. If denied → Express responds `429 Too Many Requests` with `Retry-After` header.
7. If allowed → request reaches the **route handler**, which returns `200`.
8. When the response is flushed, `res.on('finish')` fires. The logger appends one entry to the Redis Stream (`XADD rl:logs`): key, endpoint, status, latency.

### Why Redis for rate-limit state?

A naive implementation keeps counters in process memory. With two app
instances behind Nginx, each instance has its own counter — a key with a
60 req/min limit would effectively get 120 req/min. Redis provides a
**shared, atomic counter** accessible from all instances simultaneously.
Lua scripts make each counter update a single indivisible operation,
eliminating the TOCTOU race condition that would exist with separate
GET → calculate → SET calls.

### Why Redis Streams for logging?

`XADD` is O(1) and non-blocking. The log write happens in the `finish`
event after the response is already sent — zero client-visible latency.
Stream IDs are auto-generated as `{unix_ms}-{seq}`, so time-range queries
(`XRANGE rl:logs since +`) work without a secondary index.

---

## 3. Project Structure

```
Rate limiter/
├── src/
│   ├── server.js               Express app + startup (SEED_KEY, X-Served-By)
│   ├── key-registry.js         In-memory API key store; issueKey, seedRegistry
│   ├── rate-limiter.js         Abstract RateLimiter base class
│   ├── token-bucket.js         In-memory token bucket (for unit tests)
│   ├── sliding-window.js       In-memory sliding window (for unit tests)
│   ├── store.js                Abstract Store + MemoryStore
│   ├── logger.js               Redis Stream writer (log) + reader (getRecentLogs)
│   ├── analytics.js            Aggregation: req/min, block rate, top keys
│   ├── redis/
│   │   ├── index.js            Singleton ioredis client; Lua commands registered once
│   │   ├── redis-token-bucket.js   Lua-backed token bucket
│   │   └── redis-sliding-window.js Lua-backed sliding window (sorted set)
│   ├── middleware/
│   │   ├── authenticate.js     X-API-Key header check
│   │   ├── rate-limit.js       Calls limiter.tryConsume; writes Retry-After on 429
│   │   └── request-log.js      res.on('finish') → fire-and-forget XADD
│   └── routes/
│       ├── keys.js             POST /keys, GET /keys, GET /keys/tiers
│       ├── protected.js        GET /api/ping, GET /api/data
│       └── analytics.js        GET /analytics[?window=N]
├── tests/
│   ├── token-bucket.test.js    16 unit tests (Jest fake timers)
│   ├── sliding-window.test.js  16 unit tests (Jest fake timers)
│   ├── redis-limiters.test.js  13 integration tests (mock Redis client)
│   └── analytics.test.js       18 unit tests (mocked logger + key-registry)
├── dashboard/
│   ├── src/
│   │   ├── App.jsx             Root: polling hook, layout
│   │   ├── hooks/useAnalytics.js  5-second polling, manual refresh
│   │   └── components/
│   │       ├── StatCard.jsx
│   │       ├── RequestsChart.jsx  recharts AreaChart (requests + blocked)
│   │       ├── RatioWidget.jsx    Split bar + counters
│   │       └── TopKeysTable.jsx   Top 5 consumers table
│   ├── Dockerfile              Multi-stage: Vite build → nginx static server
│   └── nginx.conf              SPA fallback + /analytics proxy to gateway
├── nginx/
│   └── nginx.conf              Round-robin upstream; X-Upstream-Addr header
├── docker-compose.yml          Full 5-service stack with health-check ordering
├── Dockerfile                  Multi-stage: prod deps → non-root runtime
├── .dockerignore
├── load-test.js                Zero-dependency Node.js load test
└── .env.example
```

---

## 4. Setup Instructions

### Prerequisites

| Tool | Minimum version |
|---|---|
| Node.js | 18 LTS or later |
| npm | 9 or later |
| Redis | 6.2 or later (7 recommended) |
| Docker + Compose | Docker Desktop 4.x / Docker Engine 24.x |

---

### 4.1 Local Development

```bash
# 1. Clone and install
git clone <repo-url>
cd "Rate limiter"
npm install

# 2. Start Redis (pick one)
#    Docker:
docker run -d --name rl-redis -p 6379:6379 redis:7-alpine
#    Or native on macOS:   brew services start redis
#    Or native on Ubuntu:  sudo systemctl start redis

# 3. Copy env file
cp .env.example .env
# Edit .env if Redis is not on localhost:6379

# 4. Start the API server
node src/server.js

# 5. Start the dashboard (separate terminal)
cd dashboard
npm install
npm run dev
# Dashboard: http://localhost:5173
# API:       http://localhost:3000
```

**Quick smoke test:**

```bash
# Issue a free-tier key
KEY=$(curl -s -X POST http://localhost:3000/keys \
  -H "Content-Type: application/json" \
  -d '{"tier":"free"}' | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).key))")
echo "Key: $KEY"

# Hit a protected endpoint
curl -H "X-API-Key: $KEY" http://localhost:3000/api/ping

# Check analytics
curl http://localhost:3000/analytics | node -e \
  "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
```

---

### 4.2 Docker (Full Stack)

```bash
# Start all five services (builds images on first run)
docker compose up --build

# Services exposed on the host:
#   http://localhost:8080   → Nginx gateway (round-robin → app1 + app2)
#   http://localhost:5173   → React analytics dashboard
#   http://localhost:3001   → app1 direct (bypass nginx; for debugging)
#   http://localhost:3002   → app2 direct

# Stop and remove containers (keep Redis volume)
docker compose down

# Stop and wipe everything including stored data
docker compose down -v
```

**Environment variables (set in docker-compose.yml or override with a `.env`):**

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the Express server listens on |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `INSTANCE_NAME` | `os.hostname()` | Appears in `X-Served-By` response header |
| `SEED_KEY` | _(unset)_ | Pre-seed a key: `sk_value,tier,algorithm` |

> **SEED_KEY note:** The key registry is in-memory. With Nginx round-robin,
> a key issued via `POST /keys` only lands on one instance — the other
> returns 401. `SEED_KEY` seeds the same key on every instance at startup,
> bypassing this limitation for demos. The long-term fix is Redis-backed
> key storage.

---

## 5. API Reference

All protected endpoints require the `X-API-Key` header.

### 5.1 Key Management

#### `POST /keys` — Issue a new API key

**Request body** (JSON):

| Field | Type | Default | Description |
|---|---|---|---|
| `tier` | `string` | `"free"` | `"free"` or `"pro"` |
| `algorithm` | `string` | `"sliding-window"` | `"sliding-window"` or `"token-bucket"` |

**Response `200`:**
```json
{
  "key":       "sk_994f22df3060a8b1c4e2f1d9",
  "tier":      "free",
  "algorithm": "sliding-window",
  "limit":     60,
  "windowMs":  60000,
  "createdAt": "2026-08-09T01:00:00.000Z"
}
```

**Tier limits:**

| Tier | Requests / minute |
|---|---|
| `free` | 60 |
| `pro`  | 1,000 |

---

#### `GET /keys` — List all issued keys _(admin)_

Returns an array of key records (omits the limiter object). No authentication required.

---

#### `GET /keys/tiers` — View tier configurations

```json
{
  "free": { "limit": 60,   "windowMs": 60000 },
  "pro":  { "limit": 1000, "windowMs": 60000 }
}
```

---

### 5.2 Protected Endpoints

All return `401` if `X-API-Key` is missing or invalid.  
All return `429` with a `Retry-After` header (seconds) if the rate limit is exceeded.

#### `GET /api/ping`

Lightweight liveness check. Useful as the load-test target.

**Response `200`:**
```json
{ "message": "pong", "ts": 1723165800000 }
```

---

#### `GET /api/data`

Returns a small sample payload.

**Response `200`:**
```json
{
  "items": [...],
  "count": 3,
  "servedBy": "app1"
}
```

---

### 5.3 Analytics

#### `GET /analytics` — Aggregated statistics

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `window` | `integer` | `60` | Look-back window in minutes (1–60) |

**Response `200`:**

```json
{
  "window":           "last 60 minutes",
  "generatedAt":      "2026-08-09T01:20:00.000Z",
  "totalRequests":    1847,
  "allowedRequests":  1700,
  "blockedRequests":  147,
  "blockRate":        "7.96%",
  "avgLatencyMs":     3,
  "requestsPerMinute": [
    { "minute": "00:21", "ts": 1723165260000, "requests": 28, "blocked": 2 },
    "... 60 buckets total, oldest → newest"
  ],
  "topKeys": [
    {
      "key":       "sk_994f22df...",
      "tier":      "free",
      "algorithm": "sliding-window",
      "requests":  900,
      "blocked":   50,
      "blockRate": "5.56%"
    }
  ]
}
```

---

## 6. Load Testing

The load test proves that rate limiting is **globally enforced** across instances, not per-instance.

```bash
# Default: 100 requests, 25 concurrent, against http://localhost:8080
node load-test.js

# Custom target / key / volume
TARGET=http://localhost:8080 \
API_KEY=sk_loadtest \
TOTAL=150 \
CONCURR=30 \
  node load-test.js
```

**Expected result** (free tier, 100 requests):

```
══════════════════════════════════════════════════════════════
  RESULTS
──────────────────────────────────────────────────────────────
  Total sent        100
  Allowed (200)      60   60.0%
  Blocked (429)      40   40.0%

  PER-INSTANCE DISTRIBUTION
──────────────────────────────────────────────────────────────
  app1                  50 requests    50.0%
  app2                  50 requests    50.0%

  VERDICT
──────────────────────────────────────────────────────────────
  ✅  PASS — Redis shared counter held across instances.
```

Without Redis (per-instance in-memory counters), with 2 instances each
allowing 60 req/min, all 100 requests would have been allowed.

**Environment variables for the load test:**

| Variable | Default | Description |
|---|---|---|
| `TARGET` | `http://localhost:8080` | Base URL (gateway or direct instance) |
| `API_KEY` | `sk_loadtest` | Key seeded on both instances via `SEED_KEY` |
| `ENDPOINT` | `/api/ping` | Protected route to hammer |
| `TOTAL` | `100` | Total requests to fire |
| `CONCURR` | `25` | Maximum simultaneous connections |
| `TIER_LIMIT` | `60` | Expected allow count (used for PASS/FAIL verdict) |

---

## 7. Design Decisions

> **Note for report authors:** Each item below is a real trade-off made
> during implementation. Fill in the *Reasoning* placeholders with your
> own reflections, measurements, or references.

---

### 7.1 Rate-limiting algorithms: token bucket vs. sliding window counter

| | Token bucket | Sliding window counter |
|---|---|---|
| **Allows bursts?** | Yes — up to `capacity` tokens | No — hard limit per window |
| **Memory (Redis)** | 2 fields per key (HMSET) | O(n) sorted set entries per key |
| **Smoothness** | Gradual refill | Boundary reset |
| **Default tier** | _(selectable per key)_ | ✓ default |

> **[Your reasoning here]** — Why did you choose sliding window as the
> default? What workload characteristics made token bucket attractive for
> certain use cases? Did you measure the memory difference in Redis?

---

### 7.2 Redis Lua scripts instead of WATCH/MULTI transactions

Rate-limit logic is implemented as two Lua scripts (`tokenBucketConsume`,
`slidingWindowConsume`) loaded once via `SCRIPT LOAD` (EVALSHA path).

> **[Your reasoning here]** — Compare Redis Lua scripts to WATCH/MULTI
> transactions. When does WATCH cause retry loops under high concurrency?
> How does single-threaded Lua execution in Redis guarantee atomicity
> without locks?

---

### 7.3 Redis Streams for request logging (over Postgres)

> **[Your reasoning here]** — XADD is O(1) and appends after the response
> is already sent. What would a Postgres INSERT add to p99 latency? At
> what request volume would you reconsider Streams in favour of Postgres
> (think: week-long retention, billing JOINs, materialized views)?

---

### 7.4 Polling (5 s) for the analytics dashboard, not Server-Sent Events

> **[Your reasoning here]** — The analytics endpoint returns an aggregated
> snapshot, not a stream of events. When would SSE be the better choice?
> What server-side infrastructure does SSE require that polling does not?

---

### 7.5 In-memory key registry (and the multi-instance implication)

> **[Your reasoning here]** — The `SEED_KEY` env var is a demo workaround.
> What would a production-grade key store look like? (Redis HASH with
> HSET/HGET? Postgres table? A dedicated secrets manager?) What are the
> consistency guarantees of each?

---

### 7.6 Interface-driven storage layer (the `Store` abstraction)

The `TokenBucket` and `SlidingWindowCounter` classes are backed by an
abstract `Store` interface (`get`, `set`, `delete`). `MemoryStore` is
used in unit tests; `Redis*` classes implement the same contract at the
algorithm level.

> **[Your reasoning here]** — How did this abstraction isolate unit tests
> from infrastructure? What is the cost of the abstraction (indirection,
> interface maintenance)? Could you have just mocked Redis directly?

---

## 8. Running Tests

```bash
npm test                       # run all 63 tests
npm test -- --verbose          # with individual test names
npm test -- --coverage         # with Istanbul coverage report
npm test -- tests/analytics.test.js   # one suite only
```

**Test suites:**

| Suite | Tests | What it covers |
|---|---|---|
| `token-bucket.test.js` | 16 | Allow/deny, burst, refill boundary, idle reset |
| `sliding-window.test.js` | 16 | Allow/deny, window slide, exact boundary |
| `redis-limiters.test.js` | 13 | Redis class argument passing, key prefixing, boundary |
| `analytics.test.js` | 18 | Bucket placement, block rate, top-key sorting, metadata |

All tests run with **Jest fake timers** (no wall-clock dependency) and
**mock Redis clients** (no live Redis required). CI can run `npm test`
with no external services.
