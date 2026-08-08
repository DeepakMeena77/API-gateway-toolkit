'use strict'

/**
 * @fileoverview Append-only request log backed by a Redis Stream.
 *
 * WHY REDIS STREAMS?
 * ------------------
 * A Redis Stream (XADD) is the ideal fit here for three reasons:
 *
 * 1. ALREADY IN PLACE — Redis is already required for rate-limit counters,
 *    so we add zero new infrastructure.
 *
 * 2. OPTIMAL WRITE PATH — XADD is O(1) and fire-and-forget.  The middleware
 *    calls log() without awaiting it, so request latency is unaffected.
 *    A Postgres INSERT would add 1–5 ms per request on the hot path.
 *
 * 3. NATURAL TIME-SERIES — Stream IDs are auto-generated as "ms-sequenceNo",
 *    so XRANGE start stop gives a time-ordered slice with no extra index.
 *
 * STREAM SCHEMA (one entry per request)
 * ──────────────────────────────────────
 *   ts        Unix ms timestamp of the request
 *   apiKey    The authenticated API key
 *   method    HTTP verb (GET, POST, …)
 *   path      Request path (/api/ping, …)
 *   status    HTTP response status code
 *   allowed   '1' if the request was served, '0' if rate-limited (429)
 *   latencyMs Round-trip ms from first byte in to last byte out
 *
 * CAPACITY
 * ────────
 * MAXLEN ~ 1_000_000 entries.  At 1 000 req/min (pro tier, fully loaded)
 * that covers ~16 hours.  Approximate trimming (~) lets Redis do the
 * eviction lazily without blocking XADD.
 *
 * WHEN TO MOVE TO POSTGRES
 * ─────────────────────────
 * If you need: week-long retention, SQL GROUP BY analytics, audit trail
 * durability, or JOIN with user/billing tables — add Postgres then.
 * The interface here (log / getRecentLogs) is the only call site, so
 * swapping the backend is a two-function change.
 */

const { getClient } = require('./redis')

const STREAM_KEY = 'rl:logs'
const MAX_LEN    = 1_000_000  // approx cap; Redis trims lazily

/**
 * Append one request log entry to the Redis Stream.
 * Non-blocking: caller should fire-and-forget (.catch to suppress crashes).
 *
 * @param {Object}  entry
 * @param {number}  entry.ts          Unix ms timestamp
 * @param {string}  entry.apiKey      API key string
 * @param {string}  entry.method      HTTP method
 * @param {string}  entry.path        Request path
 * @param {number}  entry.status      HTTP status code
 * @param {boolean} entry.allowed     true = served, false = rate-limited
 * @param {number}  entry.latencyMs   Latency in milliseconds
 * @returns {Promise<void>}
 */
async function log(entry) {
  const client = getClient()
  // XADD key MAXLEN ~ cap * field value [field value ...]
  // '*' = auto-generate ID from server clock (millisecond + sequence)
  await client.xadd(
    STREAM_KEY,
    'MAXLEN', '~', String(MAX_LEN),
    '*',
    'ts',        String(entry.ts),
    'apiKey',    entry.apiKey,
    'method',    entry.method,
    'path',      entry.path,
    'status',    String(entry.status),
    'allowed',   entry.allowed ? '1' : '0',
    'latencyMs', String(entry.latencyMs)
  )
}

/**
 * Retrieve all log entries within the last `windowMs` milliseconds,
 * parsed into plain JS objects.
 *
 * XRANGE uses the auto-generated timestamp IDs, so no extra index is needed.
 *
 * @param {number} [windowMs=3_600_000]  Look-back window (default: 1 hour)
 * @returns {Promise<ParsedEntry[]>}
 *
 * @typedef {Object} ParsedEntry
 * @property {string}  _id        Redis stream ID (e.g. "1721577644000-0")
 * @property {number}  ts         Unix ms timestamp
 * @property {string}  apiKey
 * @property {string}  method
 * @property {string}  path
 * @property {number}  status
 * @property {boolean} allowed
 * @property {number}  latencyMs
 */
async function getRecentLogs(windowMs = 3_600_000) {
  const client = getClient()
  const since  = Date.now() - windowMs

  // Stream IDs are "ms-seq"; "${since}-0" means the first entry at or
  // after `since` milliseconds.  '+' means "up to the latest entry".
  const raw = await client.xrange(STREAM_KEY, `${since}-0`, '+')

  return raw.map(([id, fields]) => {
    // ioredis returns fields as a flat array: ['key','val','key','val',…]
    const obj = { _id: id }
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1]
    }
    return {
      _id:       obj._id,
      ts:        parseInt(obj.ts,        10),
      apiKey:    obj.apiKey,
      method:    obj.method,
      path:      obj.path,
      status:    parseInt(obj.status,    10),
      allowed:   obj.allowed === '1',
      latencyMs: parseInt(obj.latencyMs, 10),
    }
  })
}

module.exports = { log, getRecentLogs, STREAM_KEY }
