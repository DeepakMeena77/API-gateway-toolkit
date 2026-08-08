'use strict'

/**
 * @fileoverview Redis-backed Token Bucket rate limiter.
 *
 * WHY A LUA SCRIPT?
 * -----------------
 * A naive implementation would do:
 *
 *   const state = await client.hgetall(key)          // Step A: GET
 *   const refilled = refill(state, now)               // Step B: CALCULATE
 *   if (refilled >= 1) {
 *     await client.hmset(key, 'tokens', refilled - 1) // Step C: SET
 *     return { allowed: true }
 *   }
 *
 * THE RACE CONDITION IN THAT NAIVE APPROACH
 * -----------------------------------------
 * Imagine two app instances (I1 and I2) processing requests for the
 * same API key at the same instant, with 1 token remaining:
 *
 *   I1 ──[ HGETALL → tokens=1 ]──────────────────────────────────
 *   I2 ──────────────[ HGETALL → tokens=1 ]──────────────────────
 *   I1 ──────────────────────────[ HMSET tokens=0 → allowed ]────
 *   I2 ──────────────────────────────────[ HMSET tokens=0 → allowed ]
 *
 * Both instances read tokens=1, both calculate "allow", both write
 * tokens=0.  Two requests get through even though only one token existed.
 * This is a classic check-then-act race (TOCTOU).
 *
 * HOW THE LUA SCRIPT PREVENTS IT
 * --------------------------------
 * Redis executes Lua scripts atomically.  The entire script — HMGET,
 * arithmetic, HMSET, PEXPIRE — runs as a single, uninterruptible unit.
 * No other Redis command (from any client or instance) can interleave.
 * Redis is single-threaded for command execution, so this is a true
 * mutual exclusion without any locks or transactions.
 *
 * The call sequence becomes:
 *   I1 ──[ EVALSHA → (HMGET, calc, HMSET, PEXPIRE) → {1, 0, 0} ]──
 *   I2 ──────────────[ EVALSHA → (HMGET tokens=0, …) → {0, 0, N} ]
 *
 * I2 sees tokens=0 *after* I1 has already written, and correctly denies.
 */

const { RateLimiter } = require('../rate-limiter')

class RedisTokenBucket extends RateLimiter {
  /**
   * @param {import('ioredis').Redis} redisClient
   *   Must be the client returned by src/redis/index.js getClient(),
   *   which has tokenBucketConsume already registered.
   * @param {Object} opts
   * @param {number} opts.capacity    - Max tokens (= burst limit).
   * @param {number} opts.refillRate  - Tokens added per millisecond.
   */
  constructor(redisClient, { capacity, refillRate }) {
    super()
    if (!Number.isFinite(capacity) || capacity <= 0)
      throw new RangeError('RedisTokenBucket: capacity must be a positive number')
    if (!Number.isFinite(refillRate) || refillRate <= 0)
      throw new RangeError('RedisTokenBucket: refillRate must be a positive number')

    this._client     = redisClient
    this._capacity   = capacity
    this._refillRate = refillRate
  }

  /**
   * @param {string} key  API key string (used as part of the Redis key).
   * @returns {Promise<import('../rate-limiter').ConsumeResult>}
   */
  async tryConsume(key) {
    const now = Date.now()

    // Prefix 'rl:tb:' namespaces token-bucket keys in Redis so they
    // never collide with sliding-window keys for the same API key.
    const result = await this._client.tokenBucketConsume(
      `rl:tb:${key}`,  // KEYS[1]
      this._capacity,  // ARGV[1]
      this._refillRate,// ARGV[2]
      now              // ARGV[3]
    )

    // Lua returns an array of integers/floats encoded as bulk strings
    const [allowed, remaining, retryAfter] = result.map(Number)

    if (allowed === 1) {
      return { allowed: true, remaining }
    }
    return { allowed: false, remaining: 0, retryAfter }
  }
}

module.exports = { RedisTokenBucket }
