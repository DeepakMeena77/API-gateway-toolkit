'use strict'

const { RateLimiter } = require('./rate-limiter')

/**
 * @fileoverview Token Bucket rate limiter.
 *
 * ALGORITHM
 * ---------
 * Each key owns a "bucket" with a maximum capacity of `capacity` tokens.
 * Tokens are added continuously at `refillRate` tokens per millisecond.
 * The bucket starts full on first use (generous to new clients).
 * Each allowed request consumes exactly one token.
 * When the bucket is empty the request is denied.
 *
 * State stored per key: { tokens: number, lastRefill: number (ms timestamp) }
 *
 * TRADE-OFFS vs. Sliding Window
 * ------------------------------
 * ✅ Burst-friendly: a client that was idle accumulates tokens and can
 *    send a burst up to `capacity` without being throttled.
 * ✅ Very cheap to store: just two numbers per key.
 * ⚠️  Clock sensitivity: refill is proportional to wall-clock time, so
 *    clock skew in a multi-node setup can lead to slight over- or under-
 *    provisioning.  Use a single Redis node (or Lua scripts) to mitigate.
 * ⚠️  Burst edges: two bursts separated by just over the refill window
 *    are both allowed, which can feel surprising compared to a fixed window.
 */
class TokenBucket extends RateLimiter {
  /**
   * @param {import('./store').Store} store
   * @param {Object} opts
   * @param {number} opts.capacity
   *   Maximum tokens the bucket can hold (= max burst size).
   * @param {number} opts.refillRate
   *   Tokens added per millisecond.
   *   Example: 10 req/s  → refillRate = 10 / 1000 = 0.01
   *            1  req/s  → refillRate = 1  / 1000 = 0.001
   */
  constructor(store, { capacity, refillRate }) {
    super()
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError('TokenBucket: capacity must be a positive number')
    }
    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      throw new RangeError('TokenBucket: refillRate must be a positive number')
    }
    this._store = store
    this._capacity = capacity
    this._refillRate = refillRate  // tokens / ms
  }

  /**
   * @param {string} key
   * @returns {Promise<import('./rate-limiter').ConsumeResult>}
   */
  async tryConsume(key) {
    const now = Date.now()

    // Load existing state or initialise a full bucket for new keys
    const stored = await this._store.get(key)
    const state = stored ?? { tokens: this._capacity, lastRefill: now }

    // Refill: add tokens proportional to time elapsed since last call,
    // capped at capacity so idle keys don't accumulate infinite tokens.
    const elapsedMs = now - state.lastRefill
    const refilled = Math.min(
      this._capacity,
      state.tokens + elapsedMs * this._refillRate
    )

    if (refilled >= 1) {
      const remaining = refilled - 1
      await this._store.set(key, { tokens: remaining, lastRefill: now })
      return { allowed: true, remaining: Math.floor(remaining) }
    }

    // Deny — persist the updated (still < 1) token count so the refill
    // timer continues correctly on the next call.
    await this._store.set(key, { tokens: refilled, lastRefill: now })

    // retryAfter: ms until the bucket accumulates at least 1 token.
    const retryAfter = Math.ceil((1 - refilled) / this._refillRate)
    return { allowed: false, remaining: 0, retryAfter }
  }
}

module.exports = { TokenBucket }
