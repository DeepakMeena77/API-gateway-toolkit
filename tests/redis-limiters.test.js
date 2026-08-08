'use strict'

/**
 * Integration tests for the Redis rate-limiter classes using a mock Redis
 * client — no live Redis needed.
 *
 * APPROACH
 * --------
 * We replace the Redis client with an object that:
 *   1. Stores the Lua script bodies registered via defineCommand().
 *   2. Executes them locally in a JavaScript emulator when the command
 *      is called, using the same logic the real Lua script would use.
 *
 * This is NOT "testing the Lua interpreter" — that would require a live
 * Redis instance.  It IS testing that:
 *   - The correct arguments are passed to the Lua command.
 *   - The JS classes correctly parse the Lua return value.
 *   - allow/deny/remaining/retryAfter semantics are correct end-to-end.
 *
 * For true Lua testing, point REDIS_URL at a real Redis and run:
 *   node -e "require('./tests/redis-live-smoke.js')"
 */

const { RedisTokenBucket }   = require('../src/redis/redis-token-bucket')
const { RedisSlidingWindow }  = require('../src/redis/redis-sliding-window')

// ── In-process Lua emulator ──────────────────────────────────────────────────

/**
 * Emulate the Token Bucket Lua script in JavaScript so tests don't need Redis.
 * Logic is a direct port of the Lua in src/redis/index.js.
 */
function tokenBucketScript(store, key, capacity, refillRate, now) {
  const state     = store.get(key) ?? { tokens: null, lastRefill: null }
  let tokens      = state.tokens !== null      ? parseFloat(state.tokens)      : null
  let lastRefill  = state.lastRefill !== null  ? parseFloat(state.lastRefill)  : null

  if (tokens === null) {
    tokens     = capacity
    lastRefill = now
  }

  const elapsed  = now - lastRefill
  const refilled = Math.min(capacity, tokens + elapsed * refillRate)
  const ttl_ms   = Math.ceil(capacity / refillRate) + 5000 // eslint-disable-line

  if (refilled >= 1) {
    const remaining = refilled - 1
    store.set(key, { tokens: remaining, lastRefill: now })
    return [1, Math.floor(remaining), 0]
  } else {
    store.set(key, { tokens: refilled, lastRefill: now })
    const retryAfter = Math.ceil((1 - refilled) / refillRate)
    return [0, 0, retryAfter]
  }
}

/**
 * Emulate the Sliding Window Lua script in JavaScript.
 */
function slidingWindowScript(store, key, windowMs, limit, now, member) {
  const windowStart = now - windowMs
  const entries = store.get(key) ?? []  // [{score, member}]

  // Evict expired entries (score <= windowStart)
  const active = entries.filter(e => e.score > windowStart)
  const count  = active.length

  if (count < limit) {
    active.push({ score: now, member })
    store.set(key, active)
    return [1, limit - count - 1, 0]
  } else {
    store.set(key, active)
    const oldest     = active[0]
    const retryAfter = oldest
      ? Math.max(0, Math.ceil(oldest.score + windowMs - now))
      : 0
    return [0, 0, retryAfter]
  }
}

/**
 * Build a mock Redis client that emulates our two Lua commands.
 * The `_store` Map is exposed so tests can inspect internal state.
 */
function makeMockClient() {
  const _store = new Map()

  const client = {
    _store,
    defineCommand(name) {
      // Commands are already wired below; nothing to do here.
      // In production, defineCommand() registers EVALSHA with the server.
      void name
    },
  }

  // Emulate client.tokenBucketConsume(key, capacity, refillRate, now)
  client.tokenBucketConsume = (key, capacity, refillRate, now) =>
    Promise.resolve(
      tokenBucketScript(_store, key, Number(capacity), Number(refillRate), Number(now))
    )

  // Emulate client.slidingWindowConsume(key, windowMs, limit, now, member)
  client.slidingWindowConsume = (key, windowMs, limit, now, member) =>
    Promise.resolve(
      slidingWindowScript(_store, key, Number(windowMs), Number(limit), Number(now), member)
    )

  return client
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RedisTokenBucket (mock client)', () => {
  let client, bucket

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 })
    client = makeMockClient()
    bucket = new RedisTokenBucket(client, { capacity: 3, refillRate: 1 / 1000 })
  })

  afterEach(() => jest.useRealTimers())

  test('allows first request (bucket starts full)', async () => {
    const r = await bucket.tryConsume('k1')
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(2)
  })

  test('allows up to capacity then denies', async () => {
    await bucket.tryConsume('k1')
    await bucket.tryConsume('k1')
    await bucket.tryConsume('k1')
    const r = await bucket.tryConsume('k1')
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
    expect(r.retryAfter).toBeGreaterThan(0)
  })

  test('prefixes Redis key with rl:tb:', async () => {
    await bucket.tryConsume('mykey')
    expect(client._store.has('rl:tb:mykey')).toBe(true)
  })

  test('refills correctly after elapsed time', async () => {
    // Drain 3 tokens at t=0
    await bucket.tryConsume('k1')
    await bucket.tryConsume('k1')
    await bucket.tryConsume('k1')

    // Advance 1000ms → should have exactly 1 new token
    jest.setSystemTime(1000)
    const r = await bucket.tryConsume('k1')
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(0)
  })

  test('tokens do not exceed capacity after long idle', async () => {
    await bucket.tryConsume('k1')      // use 1 at t=0
    jest.setSystemTime(10_000)         // long idle
    const r = await bucket.tryConsume('k1')
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(2)        // capped at 3, then -1 consumed
  })

  test('different keys use different Redis entries', async () => {
    const r1 = await bucket.tryConsume('keyA')
    const r2 = await bucket.tryConsume('keyB')
    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)
    expect(client._store.has('rl:tb:keyA')).toBe(true)
    expect(client._store.has('rl:tb:keyB')).toBe(true)
  })
})

describe('RedisSlidingWindow (mock client)', () => {
  let client, limiter

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 })
    client  = makeMockClient()
    limiter = new RedisSlidingWindow(client, { windowMs: 1000, limit: 3 })
  })

  afterEach(() => jest.useRealTimers())

  test('allows first request', async () => {
    const r = await limiter.tryConsume('k1')
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(2)
  })

  test('allows up to limit then denies', async () => {
    await limiter.tryConsume('k1')
    await limiter.tryConsume('k1')
    await limiter.tryConsume('k1')
    const r = await limiter.tryConsume('k1')
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
    expect(r.retryAfter).toBeGreaterThan(0)
  })

  test('prefixes Redis key with rl:sw:', async () => {
    await limiter.tryConsume('mykey')
    expect(client._store.has('rl:sw:mykey')).toBe(true)
  })

  test('entries slide out after windowMs', async () => {
    // Fill window at t=0
    await limiter.tryConsume('k1')
    await limiter.tryConsume('k1')
    await limiter.tryConsume('k1')

    // t=1001: windowStart=1, all ts=0 entries are NOT > 1 → evicted
    jest.setSystemTime(1001)
    const r = await limiter.tryConsume('k1')
    expect(r.allowed).toBe(true)
  })

  test('timestamp exactly at window boundary is evicted (strict >)', async () => {
    // Record ts=0, then advance to t=1000: windowStart=0.  ts=0 is NOT > 0.
    await limiter.tryConsume('k1')
    jest.setSystemTime(1000)
    const r = await limiter.tryConsume('k1')
    expect(r.allowed).toBe(true)
  })

  test('retryAfter equals time until oldest entry expires', async () => {
    const lim = new RedisSlidingWindow(client, { windowMs: 1000, limit: 1 })
    jest.setSystemTime(500)
    await lim.tryConsume('k2')      // ts=500, expires at 1500

    jest.setSystemTime(700)
    const r = await lim.tryConsume('k2')  // denied at t=700
    expect(r.allowed).toBe(false)
    // retryAfter = 1500 - 700 = 800
    expect(r.retryAfter).toBe(800)
  })

  test('different keys are independent', async () => {
    const l = new RedisSlidingWindow(client, { windowMs: 1000, limit: 1 })
    const rA = await l.tryConsume('a')
    const rB = await l.tryConsume('b')
    expect(rA.allowed).toBe(true)
    expect(rB.allowed).toBe(true)
  })
})
