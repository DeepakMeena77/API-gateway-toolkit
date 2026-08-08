'use strict'

/**
 * @fileoverview Redis-backed Sliding Window Counter rate limiter.
 *
 * DATA STRUCTURE
 * --------------
 * Uses a Redis Sorted Set (ZSET) where:
 *   score  = request timestamp in Unix milliseconds
 *   member = unique string (timestamp + UUID, see below)
 *
 * This maps perfectly to ZREMRANGEBYSCORE (evict old entries) and
 * ZCARD (count live entries), making the window slide naturally.
 *
 * WHY NOT JSON-ENCODE A TIMESTAMP ARRAY IN A PLAIN KEY?
 * ------------------------------------------------------
 * The in-memory implementation stores timestamps as a JS array, which
 * is fine for a single process.  For Redis, that would mean:
 *
 *   GET key → parse JSON → filter → push → JSON.stringify → SET key
 *
 * This is GET-then-SET with extra steps.  The race condition is the
 * same as for token bucket:
 *
 *   I1 ──[ GET → [t1,t2] (count=2, limit=3) ]────────────────────
 *   I2 ──────────[ GET → [t1,t2] (count=2, limit=3) ]────────────
 *   I1 ──────────────────────────────[ SET [t1,t2,now1] → allow ]──
 *   I2 ──────────────────────────────────[ SET [t1,t2,now2] → allow ]
 *
 * I2's SET overwrites I1's write.  The window now has 3 entries when
 * it should have 4 — one request silently disappears from the count.
 * Worse, if the limit was 3 you've now issued 4 allowed requests.
 *
 * HOW THE SORTED SET + LUA PREVENTS IT
 * --------------------------------------
 * ZADD/ZCARD are O(log N) Redis commands that modify the set in place.
 * By running ZREMRANGEBYSCORE + ZCARD + ZADD atomically inside a Lua
 * script, the entire check-and-add is a single Redis operation:
 *
 *   I1 ──[ EVALSHA (ZREM, ZCARD=2, ZADD now1, PEXPIRE) → {1,0,0} ]──
 *   I2 ────────[ EVALSHA (ZREM, ZCARD=3, PEXPIRE)      → {0,0,N} ]──
 *
 * I2 now sees ZCARD=3 (after I1's ZADD is already committed) and
 * correctly gets denied.
 *
 * WHY UNIQUE MEMBERS?
 * -------------------
 * Two requests arriving in the same millisecond would produce the same
 * timestamp.  ZADD with duplicate members just updates the score —
 * effectively collapsing two requests into one entry and under-counting.
 * Appending a UUID to the member makes every entry unique.
 */

const crypto = require('crypto')
const { RateLimiter } = require('../rate-limiter')

class RedisSlidingWindow extends RateLimiter {
  /**
   * @param {import('ioredis').Redis} redisClient
   * @param {Object} opts
   * @param {number} opts.windowMs  - Sliding window duration in ms.
   * @param {number} opts.limit     - Max requests within the window.
   */
  constructor(redisClient, { windowMs, limit }) {
    super()
    if (!Number.isFinite(windowMs) || windowMs <= 0)
      throw new RangeError('RedisSlidingWindow: windowMs must be a positive number')
    if (!Number.isInteger(limit) || limit <= 0)
      throw new RangeError('RedisSlidingWindow: limit must be a positive integer')

    this._client   = redisClient
    this._windowMs = windowMs
    this._limit    = limit
  }

  /**
   * @param {string} key
   * @returns {Promise<import('../rate-limiter').ConsumeResult>}
   */
  async tryConsume(key) {
    const now = Date.now()

    // Unique member: timestamp prefix aids human debugging in redis-cli;
    // UUID suffix prevents two same-ms requests from colliding in the ZSET.
    const member = `${now}:${crypto.randomUUID()}`

    const result = await this._client.slidingWindowConsume(
      `rl:sw:${key}`,  // KEYS[1]
      this._windowMs,  // ARGV[1]
      this._limit,     // ARGV[2]
      now,             // ARGV[3]
      member           // ARGV[4]
    )

    const [allowed, remaining, retryAfter] = result.map(Number)

    if (allowed === 1) {
      return { allowed: true, remaining }
    }
    return { allowed: false, remaining: 0, retryAfter }
  }
}

module.exports = { RedisSlidingWindow }
