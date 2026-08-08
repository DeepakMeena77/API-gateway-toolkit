'use strict'

/**
 * @fileoverview Common interface that every rate-limiting strategy must satisfy.
 *
 * WHY A BASE CLASS INSTEAD OF A DUCK-TYPED OBJECT?
 * -------------------------------------------------
 * JavaScript doesn't have interfaces, but an abstract base class with
 * explicit throws serves three purposes:
 *   1. Documents the contract in one place.
 *   2. Fails fast with a clear message if a subclass forgets to implement.
 *   3. Lets instanceof checks work (useful when you store limiters in a registry).
 */

/**
 * @typedef {Object} ConsumeResult
 * @property {boolean} allowed
 *   True if the request is permitted; false if it must be rejected.
 * @property {number} remaining
 *   How much capacity is still available after this call.
 *   For token bucket: remaining tokens (floored).
 *   For sliding window: remaining slots in the current window.
 * @property {number} [retryAfter]
 *   Only present when allowed === false.
 *   Milliseconds the client should wait before retrying.
 */

class RateLimiter {
  /**
   * Attempt to consume one unit of capacity for the given key.
   *
   * Implementations MUST be safe to call concurrently for different keys.
   * Concurrent calls for the SAME key may experience races with the
   * in-memory store; that is acceptable for the in-memory implementation
   * but should be resolved with atomic operations in a Redis implementation.
   *
   * @param {string} key  Unique identifier — API key, client IP, user ID, etc.
   * @returns {Promise<ConsumeResult>}
   */
  async tryConsume(key) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}.tryConsume() not implemented`)
  }
}

module.exports = { RateLimiter }
