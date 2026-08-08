'use strict'

/**
 * @fileoverview In-memory API key registry with Redis-backed rate limiters.
 *
 * Responsibilities
 * ----------------
 *  1. Define tier configurations (limit + window duration).
 *  2. Issue new API keys and bind each one to a Redis-backed limiter.
 *  3. Look up a key at request time so the middleware can call tryConsume().
 *
 * What stays in-memory vs what moved to Redis
 * -------------------------------------------
 *  IN-MEMORY : the `registry` Map (API key → metadata + limiter reference).
 *              This is intentional for this sprint — adding persistence for
 *              keys is a separate concern (next step: store in Redis HASH).
 *
 *  IN REDIS  : all rate-limit counters (token counts, request timestamps).
 *              Multiple app instances share the same Redis counters, so
 *              limits are enforced correctly across the fleet.
 */

const crypto                   = require('crypto')
const { getClient }            = require('./redis')
const { RedisTokenBucket }     = require('./redis/redis-token-bucket')
const { RedisSlidingWindow }   = require('./redis/redis-sliding-window')

// ── Tier definitions ────────────────────────────────────────────────────────

/**
 * Each tier specifies how many requests are allowed per window.
 * The same numbers are used to configure both algorithms:
 *   - SlidingWindowCounter: limit requests in windowMs.
 *   - TokenBucket:          capacity = limit, refillRate = limit / windowMs.
 *
 * @type {Record<string, { limit: number, windowMs: number }>}
 */
const TIERS = {
  free: { limit: 60,   windowMs: 60_000 },  // 60  req / min
  pro:  { limit: 1000, windowMs: 60_000 },  // 1 000 req / min
}

// ── In-memory registry ──────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyRecord
 * @property {string}      key        - The issued API key string.
 * @property {string}      tier       - 'free' | 'pro'
 * @property {string}      algorithm  - 'sliding-window' | 'token-bucket'
 * @property {number}      limit      - Requests allowed per window.
 * @property {number}      windowMs   - Window duration in ms.
 * @property {import('./rate-limiter').RateLimiter} limiter - Bound limiter instance.
 * @property {string}      createdAt  - ISO timestamp.
 */

/** @type {Map<string, KeyRecord>} */
const registry = new Map()

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a Redis-backed limiter for the given tier and algorithm.
 *
 * Both implementations call the shared Redis client, which has the
 * Lua commands pre-registered (see src/redis/index.js).
 *
 * @param {string} tier
 * @param {string} algorithm
 * @returns {import('./rate-limiter').RateLimiter}
 */
function createLimiter(tier, algorithm) {
  const { limit, windowMs } = TIERS[tier]
  const client = getClient()

  if (algorithm === 'token-bucket') {
    return new RedisTokenBucket(client, {
      capacity:   limit,
      refillRate: limit / windowMs,  // tokens per ms
    })
  }

  // Default: sliding-window
  return new RedisSlidingWindow(client, { windowMs, limit })
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Pre-populate the registry with a caller-supplied key value.
 *
 * WHY THIS EXISTS
 * ---------------
 * The key registry is in-memory, which means each app instance starts
 * with an empty registry.  For multi-instance deployments, any key
 * issued through nginx lands on whichever instance handles that request;
 * the other instance won't know about it and will return 401.
 *
 * seedRegistry() is called at startup when the SEED_KEY environment
 * variable is set (format: "sk_value,tier,algorithm").  Because every
 * instance reads the same env var, they all start with the same key —
 * so nginx can round-robin freely and every instance accepts it.
 *
 * This is the right approach for the load-test demo.  The long-term fix
 * is moving key storage to Redis (HSET/HGET), which is a natural next
 * sprint once key persistence becomes a requirement.
 *
 * @param {string} keyValue   - The exact key string to register.
 * @param {string} [tier]     - 'free' | 'pro'  (default 'free')
 * @param {string} [algorithm]- 'sliding-window' | 'token-bucket'
 * @returns {KeyRecord}
 */
function seedRegistry(keyValue, tier = 'free', algorithm = 'sliding-window') {
  if (!keyValue) throw new Error('seedRegistry: keyValue is required')
  if (!TIERS[tier]) {
    throw new Error(`seedRegistry: unknown tier "${tier}"`)
  }
  if (registry.has(keyValue)) {
    // Idempotent: called once per process, but guard against double-init.
    return registry.get(keyValue)
  }

  const tierCfg = TIERS[tier]
  /** @type {KeyRecord} */
  const record = {
    key:       keyValue,
    tier,
    algorithm,
    limit:     tierCfg.limit,
    windowMs:  tierCfg.windowMs,
    limiter:   createLimiter(tier, algorithm),
    createdAt: new Date().toISOString(),
    seeded:    true,  // flag so the admin /keys endpoint can show provenance
  }
  registry.set(keyValue, record)
  return record
}

/**
 * Issue a new API key.
 * @param {Object} [opts]
 * @param {string} [opts.tier='free']               - 'free' | 'pro'
 * @param {string} [opts.algorithm='sliding-window'] - 'sliding-window' | 'token-bucket'
 * @returns {KeyRecord}
 */
function issueKey({ tier = 'free', algorithm = 'sliding-window' } = {}) {
  if (!TIERS[tier]) {
    throw new Error(`Unknown tier "${tier}". Valid options: ${Object.keys(TIERS).join(', ')}`)
  }
  if (!['sliding-window', 'token-bucket'].includes(algorithm)) {
    throw new Error(`Unknown algorithm "${algorithm}". Valid options: sliding-window, token-bucket`)
  }

  // Prefix makes keys identifiable at a glance (like Stripe's sk_ convention)
  const key     = `sk_${crypto.randomUUID().replace(/-/g, '')}`
  const tierCfg = TIERS[tier]

  /** @type {KeyRecord} */
  const record = {
    key,
    tier,
    algorithm,
    limit:     tierCfg.limit,
    windowMs:  tierCfg.windowMs,
    limiter:   createLimiter(tier, algorithm),
    createdAt: new Date().toISOString(),
  }

  registry.set(key, record)
  return record
}

/**
 * Look up an API key.
 * @param {string} key
 * @returns {KeyRecord|null}
 */
function lookup(key) {
  return registry.get(key) ?? null
}

/**
 * List all issued keys (without the limiter object — for the admin endpoint).
 * @returns {Omit<KeyRecord, 'limiter'>[]}
 */
function listKeys() {
  return [...registry.values()].map(({ limiter: _l, ...rest }) => rest)
}

module.exports = { issueKey, seedRegistry, lookup, listKeys, TIERS }
