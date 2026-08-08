'use strict'

/**
 * @fileoverview Storage abstraction layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Both rate-limiting algorithms need to persist state (token counts,
 * request timestamps) between calls.  Hardcoding a Map inside each
 * algorithm would make the storage layer impossible to swap.
 *
 * Instead, every algorithm receives a Store instance and calls only
 * three methods: get / set / delete.  To move from in-memory to Redis
 * you write one new class (RedisStore) that implements the same three
 * methods — the algorithms never change.
 *
 * REDIS MAPPING (for reference when you build RedisStore)
 * -------------------------------------------------------
 *   get(key)               →  JSON.parse(await client.get(key))
 *   set(key, value, ttlMs) →  await client.set(key, JSON.stringify(value), { PX: ttlMs })
 *   delete(key)            →  await client.del(key)
 *
 * Note: For the sliding-window algorithm, a Redis Sorted Set
 * (ZADD / ZREMRANGEBYSCORE / ZCARD) would be more memory-efficient than
 * JSON-encoding a timestamp array, but the Store interface remains the
 * same — you'd just change how RedisStore serialises sliding-window state.
 */

class Store {
  /**
   * Retrieve the value stored under `key`, or null if absent.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(key) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}.get() not implemented`)
  }

  /**
   * Persist `value` under `key`, optionally expiring after `ttlMs` ms.
   * @param {string} key
   * @param {any}    value
   * @param {number} [ttlMs]  Optional time-to-live in milliseconds.
   * @returns {Promise<void>}
   */
  async set(key, value, ttlMs) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}.set() not implemented`)
  }

  /**
   * Remove the value stored under `key`.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}.delete() not implemented`)
  }
}

/**
 * In-memory store backed by a plain Map.
 * TTL is implemented with setTimeout so it mirrors how Redis PEXPIRE behaves.
 *
 * Thread-safety note: Node.js is single-threaded so there are no
 * data races, but the set + get pair is NOT atomic — that's fine for
 * in-memory use.  A Redis Lua script (or a transaction) would be needed
 * for true atomicity in a distributed scenario.
 */
class MemoryStore extends Store {
  constructor() {
    super()
    /** @type {Map<string, any>} */
    this._data = new Map()
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this._timers = new Map()
  }

  async get(key) {
    return this._data.get(key) ?? null
  }

  async set(key, value, ttlMs) {
    this._data.set(key, value)

    // Cancel any previous expiry timer for this key
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key))
      this._timers.delete(key)
    }

    if (ttlMs != null && ttlMs > 0) {
      const timer = setTimeout(() => {
        this._data.delete(key)
        this._timers.delete(key)
      }, ttlMs)

      // Prevent the timer from blocking Node from exiting in tests
      if (timer.unref) timer.unref()

      this._timers.set(key, timer)
    }
  }

  async delete(key) {
    if (this._timers.has(key)) {
      clearTimeout(this._timers.get(key))
      this._timers.delete(key)
    }
    this._data.delete(key)
  }

  /** Testing utility — returns a snapshot of all live entries. */
  snapshot() {
    return Object.fromEntries(this._data)
  }
}

module.exports = { Store, MemoryStore }
