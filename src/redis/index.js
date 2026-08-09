'use strict'

/**
 * @fileoverview Redis client singleton with Lua commands pre-loaded.
 *
 * WHY DEFINE COMMANDS HERE (not in each class constructor)?
 * ---------------------------------------------------------
 * ioredis's defineCommand() patches the client instance.  Calling it
 * from multiple class constructors that share the same client would
 * silently overwrite the previous definition each time — harmless, but
 * wasteful on every key creation.  Defining them once in getClient()
 * keeps the client's command surface stable and predictable.
 *
 * EVALSHA vs EVAL
 * ---------------
 * defineCommand() sends SCRIPT LOAD on the first call, then uses
 * EVALSHA for subsequent calls (Redis caches the script by its SHA-1
 * digest).  This avoids re-transmitting the full Lua source on every
 * request — important at high throughput.
 */

const Redis = require('ioredis')

// ── Lua scripts ──────────────────────────────────────────────────────────────
// Defined here so they are loaded into Redis exactly once, when the
// client is first created.

/**
 * Token Bucket — atomic check-and-decrement.
 *
 * KEYS[1]  = hash key  (e.g. "rl:tb:sk_abc123")
 * ARGV[1]  = capacity  (number of tokens, same as burst limit)
 * ARGV[2]  = refill_rate (tokens per millisecond)
 * ARGV[3]  = now (Unix ms, passed from Node so clocks stay in JS)
 *
 * Returns an array: { allowed (0|1), remaining, retry_after_ms }
 */
const TOKEN_BUCKET_LUA = `
local key         = KEYS[1]
local capacity    = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now         = tonumber(ARGV[3])

-- Load current bucket state
local data        = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens      = tonumber(data[1])
local last_refill = tonumber(data[2])

-- Initialise: first ever request for this key starts with a full bucket
if tokens == nil then
  tokens      = capacity
  last_refill = now
end

-- Continuous refill: add tokens proportional to elapsed time, cap at capacity
local elapsed  = now - last_refill
local refilled = math.min(capacity, tokens + elapsed * refill_rate)

-- TTL keeps the key alive long enough to fully refill from empty, plus a
-- small buffer.  After this window of inactivity the next request just
-- re-initialises the bucket (which is correct — idle = full bucket).
local ttl_ms = math.ceil(capacity / refill_rate) + 5000

if refilled >= 1 then
  local remaining = refilled - 1
  redis.call('HMSET', key, 'tokens', remaining, 'last_refill', now)
  redis.call('PEXPIRE', key, ttl_ms)
  return { 1, math.floor(remaining), 0 }
else
  -- Persist even on deny so the refill timer advances correctly
  redis.call('HMSET', key, 'tokens', refilled, 'last_refill', now)
  redis.call('PEXPIRE', key, ttl_ms)
  local retry_after = math.ceil((1 - refilled) / refill_rate)
  return { 0, 0, retry_after }
end
`

/**
 * Sliding Window Counter — atomic trim-count-maybe-add.
 *
 * Uses a Redis Sorted Set where score = request timestamp (ms).
 * This is more memory-efficient than JSON-encoding a timestamp array
 * and maps directly to ZREMRANGEBYSCORE / ZCARD semantics.
 *
 * KEYS[1]  = sorted-set key  (e.g. "rl:sw:sk_abc123")
 * ARGV[1]  = window_ms
 * ARGV[2]  = limit
 * ARGV[3]  = now (Unix ms)
 * ARGV[4]  = member (unique string; guarantees ZADD doesn't deduplicate
 *            two requests that arrive within the same millisecond)
 *
 * Returns an array: { allowed (0|1), remaining, retry_after_ms }
 */
const SLIDING_WINDOW_LUA = `
local key          = KEYS[1]
local window_ms    = tonumber(ARGV[1])
local limit        = tonumber(ARGV[2])
local now          = tonumber(ARGV[3])
local member       = ARGV[4]
local window_start = now - window_ms

-- Evict timestamps that have slid out of the window.
-- Scores <= window_start are expired (matches JS: t > windowStart).
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

local count = tonumber(redis.call('ZCARD', key))

if count < limit then
  -- Record this request (score = timestamp, member = unique id)
  redis.call('ZADD', key, now, member)
  -- Reset TTL so the key auto-expires after a full idle window
  redis.call('PEXPIRE', key, window_ms)
  return { 1, limit - count - 1, 0 }
else
  -- Denied — don't record the timestamp, just refresh TTL
  redis.call('PEXPIRE', key, window_ms)
  -- Oldest entry's score tells us exactly when one slot will free up
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry_after = 0
  if oldest and #oldest >= 2 then
    retry_after = math.max(0, math.ceil(tonumber(oldest[2]) + window_ms - now))
  end
  return { 0, 0, retry_after }
end
`

// ── Singleton client ─────────────────────────────────────────────────────────

let _client = null

/**
 * Return (and lazily create) the shared Redis client.
 * All Lua commands are registered once on first call.
 *
 * @returns {import('ioredis').Redis}
 */
function getClient() {
  if (_client) return _client

  const url = process.env.REDIS_URL || 'redis://localhost:6379'

  // Upstash (and any other TLS Redis) uses the rediss:// scheme.
  // ioredis requires explicit tls options to complete the TLS handshake —
  // the scheme alone is not enough on some Node versions / hosting environments.
  const isTLS = url.startsWith('rediss://')

  _client = new Redis(url, {
    // Fail fast on startup rather than queuing commands indefinitely
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Don't block the process from exiting when idle
    lazyConnect: false,
    // Required for Upstash / any managed TLS Redis endpoint
    ...(isTLS && { tls: { rejectUnauthorized: false } }),
  })

  // Load both Lua scripts; Redis caches them by SHA-1 (EVALSHA)
  _client.defineCommand('tokenBucketConsume', {
    numberOfKeys: 1,
    lua: TOKEN_BUCKET_LUA,
  })

  _client.defineCommand('slidingWindowConsume', {
    numberOfKeys: 1,
    lua: SLIDING_WINDOW_LUA,
  })

  _client.on('connect', () =>
    console.log(`[redis] connected  →  ${url}`)
  )
  _client.on('error', (err) =>
    console.error('[redis] error:', err.message)
  )

  return _client
}

/**
 * Send PING to Redis — use on startup to verify connectivity.
 * @returns {Promise<string>} 'PONG'
 */
async function ping() {
  return getClient().ping()
}

/**
 * Gracefully close the connection (call during server shutdown).
 * @returns {Promise<void>}
 */
async function quit() {
  if (_client) {
    await _client.quit()
    _client = null
  }
}

module.exports = { getClient, ping, quit }
