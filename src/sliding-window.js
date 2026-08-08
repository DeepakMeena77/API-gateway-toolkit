'use strict'

const { RateLimiter } = require('./rate-limiter')

/**
 * @fileoverview Sliding Window Counter rate limiter.
 *
 * ALGORITHM
 * ---------
 * The store holds an ordered array of request timestamps for each key.
 * On every call:
 *   1. Load the array (or start with []).
 *   2. Evict any timestamp older than (now - windowMs) — these have
 *      "slid out" of the window.
 *   3. If the remaining count is < limit, append `now` and allow.
 *   4. Otherwise deny; the oldest remaining timestamp tells us exactly
 *      when the next slot will open.
 *
 * State stored per key: number[]  (Unix ms timestamps, ascending)
 *
 * TRADE-OFFS vs. Token Bucket
 * ----------------------------
 * ✅ No burst at window edges: a client cannot make `limit` requests
 *    at 11:59:59.9 and another `limit` at 12:00:00.1 the way a fixed-
 *    window counter allows.  Every request is counted against a true
 *    rolling window.
 * ✅ retryAfter is precise: we know exactly when the oldest request
 *    slides out.
 * ⚠️  Memory scales with request volume: each allowed request adds a
 *    timestamp.  For high-throughput keys, prefer a Redis Sorted Set
 *    (ZADD/ZRANGEBYSCORE) over a JSON-encoded array.
 * ⚠️  No concept of "earning" capacity during idle time — unlike token
 *    bucket, a quiet period doesn't give you a burst allowance.
 */
class SlidingWindowCounter extends RateLimiter {
  /**
   * @param {import('./store').Store} store
   * @param {Object} opts
   * @param {number} opts.windowMs  Length of the sliding window in milliseconds.
   * @param {number} opts.limit     Maximum requests permitted within the window.
   */
  constructor(store, { windowMs, limit }) {
    super()
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('SlidingWindowCounter: windowMs must be a positive number')
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('SlidingWindowCounter: limit must be a positive integer')
    }
    this._store = store
    this._windowMs = windowMs
    this._limit = limit
  }

  /**
   * @param {string} key
   * @returns {Promise<import('./rate-limiter').ConsumeResult>}
   */
  async tryConsume(key) {
    const now = Date.now()
    // Any timestamp at or before windowStart is outside the window.
    // We use strict ">" in the filter so a timestamp exactly at the
    // boundary (t === windowStart) is considered expired.
    const windowStart = now - this._windowMs

    /** @type {number[]} */
    const timestamps = (await this._store.get(key)) ?? []

    // Evict expired timestamps (sliding the window forward)
    const active = timestamps.filter(t => t > windowStart)

    if (active.length < this._limit) {
      active.push(now)
      // TTL = full window so Redis (or MemoryStore) auto-expires idle keys
      await this._store.set(key, active, this._windowMs)
      return { allowed: true, remaining: this._limit - active.length }
    }

    // Deny — persist trimmed list without adding the rejected timestamp
    await this._store.set(key, active, this._windowMs)

    // retryAfter: ms until the oldest active timestamp slides out,
    // freeing one slot.
    const retryAfter = active[0] + this._windowMs - now
    return { allowed: false, remaining: 0, retryAfter }
  }
}

module.exports = { SlidingWindowCounter }
