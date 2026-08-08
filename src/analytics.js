'use strict'

/**
 * @fileoverview Analytics aggregation over the request log stream.
 *
 * All aggregations are computed in Node.js over the raw log entries
 * returned by getRecentLogs().  For 1 000 req/min over 60 minutes
 * that is ≤ 60 000 objects — well within V8's capacity for a single
 * synchronous loop.
 *
 * If traffic grows significantly (millions of requests per hour) the
 * right move is server-side aggregation: pre-computed Redis counters
 * (HINCRBY per minute bucket + per key) updated in the log() call,
 * or a materialized view in Postgres.  The computeAnalytics() signature
 * stays the same either way.
 */

const { getRecentLogs } = require('./logger')
const { lookup }        = require('./key-registry')

/**
 * @typedef {Object} AnalyticsResult
 * @property {string}   window              Human-readable window label
 * @property {string}   generatedAt         ISO timestamp of computation
 * @property {number}   totalRequests
 * @property {number}   allowedRequests
 * @property {number}   blockedRequests
 * @property {string}   blockRate           e.g. "5.16%"
 * @property {number}   avgLatencyMs        Average response latency
 * @property {MinuteBucket[]} requestsPerMinute  Oldest → newest
 * @property {KeyStat[]}      topKeys        Top 5 keys by request count
 *
 * @typedef {Object} MinuteBucket
 * @property {string} minute  "HH:MM" UTC
 * @property {number} ts      Unix ms of bucket start
 * @property {number} requests
 * @property {number} blocked
 *
 * @typedef {Object} KeyStat
 * @property {string} key
 * @property {string} tier
 * @property {string} algorithm
 * @property {number} requests
 * @property {number} blocked
 * @property {string} blockRate
 */

/**
 * Compute analytics from the Redis log stream.
 *
 * @param {Object} [opts]
 * @param {number} [opts.windowMs=3_600_000]  Look-back window in ms
 * @returns {Promise<AnalyticsResult>}
 */
async function computeAnalytics({ windowMs = 3_600_000 } = {}) {
  const now  = Date.now()
  const logs = await getRecentLogs(windowMs)

  // ── 1. Requests-per-minute buckets (oldest → newest) ──────────────────
  // We split the window into 1-minute buckets.  Bucket index 0 is the
  // oldest (e.g. 60 minutes ago), index BUCKETS-1 is the current minute.
  const BUCKETS = Math.ceil(windowMs / 60_000)

  // Each bucket holds { requests, blocked } counts
  const bins = Array.from({ length: BUCKETS }, () => ({ requests: 0, blocked: 0 }))

  for (const entry of logs) {
    const minsAgo = Math.floor((now - entry.ts) / 60_000)
    if (minsAgo >= 0 && minsAgo < BUCKETS) {
      const idx = BUCKETS - 1 - minsAgo  // newest = last index
      bins[idx].requests++
      if (!entry.allowed) bins[idx].blocked++
    }
  }

  const requestsPerMinute = bins.map((bin, i) => {
    const bucketStart = now - (BUCKETS - 1 - i) * 60_000
    return {
      minute:   new Date(bucketStart).toISOString().slice(11, 16),  // "HH:MM" UTC
      ts:       bucketStart,
      requests: bin.requests,
      blocked:  bin.blocked,
    }
  })

  // ── 2. Totals ──────────────────────────────────────────────────────────
  const total   = logs.length
  const blocked = logs.filter(e => !e.allowed).length
  const allowed = total - blocked

  const blockRate = total > 0
    ? ((blocked / total) * 100).toFixed(2) + '%'
    : '0.00%'

  // ── 3. Average latency (ms) ────────────────────────────────────────────
  const avgLatencyMs = total > 0
    ? Math.round(logs.reduce((sum, e) => sum + e.latencyMs, 0) / total)
    : 0

  // ── 4. Top 5 API keys by total request count ───────────────────────────
  // Build a map: apiKey → { requests, blocked }
  const keyMap = new Map()
  for (const entry of logs) {
    if (!keyMap.has(entry.apiKey)) {
      keyMap.set(entry.apiKey, { requests: 0, blocked: 0 })
    }
    const s = keyMap.get(entry.apiKey)
    s.requests++
    if (!entry.allowed) s.blocked++
  }

  const topKeys = [...keyMap.entries()]
    .sort(([, a], [, b]) => b.requests - a.requests)
    .slice(0, 5)
    .map(([key, stats]) => {
      const record = lookup(key)  // may be null if server was restarted
      return {
        key,
        tier:      record?.tier      ?? 'unknown',
        algorithm: record?.algorithm ?? 'unknown',
        requests:  stats.requests,
        blocked:   stats.blocked,
        blockRate: stats.requests > 0
          ? ((stats.blocked / stats.requests) * 100).toFixed(2) + '%'
          : '0.00%',
      }
    })

  return {
    window:           `last ${Math.round(windowMs / 60_000)} minutes`,
    generatedAt:      new Date(now).toISOString(),
    totalRequests:    total,
    allowedRequests:  allowed,
    blockedRequests:  blocked,
    blockRate,
    avgLatencyMs,
    requestsPerMinute,
    topKeys,
  }
}

module.exports = { computeAnalytics }
