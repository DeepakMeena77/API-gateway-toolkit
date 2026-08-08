'use strict'

const { MemoryStore }  = require('../src/store')
const { TokenBucket }  = require('../src/token-bucket')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh store + bucket for each test.
 * Default: capacity=3, refillRate=1 token per 1 000 ms (1 req/s).
 */
function setup({ capacity = 3, refillRate = 1 / 1000 } = {}) {
  const store  = new MemoryStore()
  const bucket = new TokenBucket(store, { capacity, refillRate })
  return { store, bucket }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TokenBucket', () => {

  beforeEach(() => {
    // Use Jest's modern fake timers so jest.setSystemTime() controls Date.now()
    jest.useFakeTimers({ now: 0 })  // start at t = 0 ms
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // ── 1. Normal allow / deny ──────────────────────────────────────────────

  describe('normal allow / deny', () => {
    test('allows the first request on a fresh key (bucket starts full)', async () => {
      const { bucket } = setup()
      const result = await bucket.tryConsume('k1')
      expect(result.allowed).toBe(true)
    })

    test('returns correct remaining count after each consume', async () => {
      const { bucket } = setup({ capacity: 5 })
      const r1 = await bucket.tryConsume('k1')
      expect(r1.allowed).toBe(true)
      expect(r1.remaining).toBe(4)

      const r2 = await bucket.tryConsume('k1')
      expect(r2.remaining).toBe(3)
    })

    test('allows exactly `capacity` requests in a row, then denies', async () => {
      const { bucket } = setup({ capacity: 3 })

      // Sequential awaits are required here: concurrent calls via Promise.all
      // would all read the same initial state (tokens=3) before any write
      // completes, causing all to succeed.  The MemoryStore comments document
      // this expected non-atomicity; a Redis Lua script would handle it.
      const r1 = await bucket.tryConsume('k1')
      const r2 = await bucket.tryConsume('k1')
      const r3 = await bucket.tryConsume('k1')
      expect([r1, r2, r3].every(r => r.allowed)).toBe(true)

      const denied = await bucket.tryConsume('k1')
      expect(denied.allowed).toBe(false)
      expect(denied.remaining).toBe(0)
    })

    test('denied result includes a positive retryAfter value', async () => {
      const { bucket } = setup({ capacity: 1 })
      await bucket.tryConsume('k1')            // empties the bucket
      const r = await bucket.tryConsume('k1')  // should deny
      expect(r.allowed).toBe(false)
      expect(typeof r.retryAfter).toBe('number')
      expect(r.retryAfter).toBeGreaterThan(0)
    })

    test('different keys have independent buckets', async () => {
      const { bucket } = setup({ capacity: 1 })
      const rA = await bucket.tryConsume('keyA')
      const rB = await bucket.tryConsume('keyB')
      expect(rA.allowed).toBe(true)
      expect(rB.allowed).toBe(true)  // keyB still has its own full bucket

      const rA2 = await bucket.tryConsume('keyA')
      expect(rA2.allowed).toBe(false)  // keyA exhausted
    })
  })

  // ── 2. Burst behavior ───────────────────────────────────────────────────

  describe('burst behavior', () => {
    test('absorbs a full burst up to capacity then denies extras', async () => {
      const { bucket } = setup({ capacity: 5 })
      const results = []
      for (let i = 0; i < 8; i++) {
        results.push(await bucket.tryConsume('k1'))
      }
      expect(results.filter(r =>  r.allowed)).toHaveLength(5) // burst window
      expect(results.filter(r => !r.allowed)).toHaveLength(3) // over-burst
    })

    test('remaining drops by 1 for every allowed call during a burst', async () => {
      const { bucket } = setup({ capacity: 4 })
      const remainingValues = []
      for (let i = 0; i < 4; i++) {
        const r = await bucket.tryConsume('k1')
        remainingValues.push(r.remaining)
      }
      expect(remainingValues).toEqual([3, 2, 1, 0])
    })

    test('retryAfter grows as the bucket stays empty', async () => {
      // refillRate = 1 token per 1 000 ms
      // After draining, each denied call happens at the same time (t=0),
      // so retryAfter should be the same (≈1000ms) for all denied calls.
      const { bucket } = setup({ capacity: 1, refillRate: 1 / 1000 })
      await bucket.tryConsume('k1')            // t=0, consumes 1 token → 0 left

      const d1 = await bucket.tryConsume('k1') // t=0 still, tokens ≈ 0
      const d2 = await bucket.tryConsume('k1') // t=0 still

      expect(d1.allowed).toBe(false)
      expect(d2.allowed).toBe(false)
      // Both retryAfter values should be ~1000ms (ceiling of 1/refillRate)
      expect(d1.retryAfter).toBe(1000)
      expect(d2.retryAfter).toBe(1000)
    })
  })

  // ── 3. Refill boundary ──────────────────────────────────────────────────

  describe('refill boundary', () => {
    test('allows a request after exactly one full refill period', async () => {
      // capacity=1, refillRate=1/1000 → 1 token per 1 000 ms
      const { bucket } = setup({ capacity: 1, refillRate: 1 / 1000 })

      await bucket.tryConsume('k1')  // t=0, empties the bucket

      jest.setSystemTime(1000)       // t=1000ms → bucket has exactly 1 token
      const r = await bucket.tryConsume('k1')
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(0)   // used the one refilled token
    })

    test('denies at 1 ms before the refill threshold', async () => {
      const { bucket } = setup({ capacity: 1, refillRate: 1 / 1000 })

      await bucket.tryConsume('k1')  // t=0, empty

      jest.setSystemTime(999)        // 999ms elapsed → only 0.999 tokens
      const r = await bucket.tryConsume('k1')
      expect(r.allowed).toBe(false)
    })

    test('tokens do NOT exceed capacity after a long idle period', async () => {
      // capacity=3, refillRate=1/1000 → left idle for 10 s
      // Without capping: 3 + (10 000 * 0.001) = 13 tokens — wrong
      // With capping:    min(3, 13) = 3 tokens
      const { bucket } = setup({ capacity: 3, refillRate: 1 / 1000 })

      await bucket.tryConsume('k1')  // use 1 at t=0 → 2 left

      jest.setSystemTime(10_000)     // 10 seconds later
      const r = await bucket.tryConsume('k1')
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(2)   // capped at 3, minus 1 consumed
    })

    test('partial refill does not allow a request before threshold', async () => {
      // capacity=2, refillRate=1/1000; drain both tokens at t=0
      const { bucket } = setup({ capacity: 2, refillRate: 1 / 1000 })
      await bucket.tryConsume('k1')
      await bucket.tryConsume('k1') // 0 tokens at t=0

      jest.setSystemTime(500)       // 500ms → 0.5 tokens, still < 1
      const r = await bucket.tryConsume('k1')
      expect(r.allowed).toBe(false)
    })

    test('refill resumes correctly after a denied call', async () => {
      // Ensures a denied call (which updates lastRefill) does not reset
      // the clock unfairly.
      const { bucket } = setup({ capacity: 1, refillRate: 1 / 1000 })

      await bucket.tryConsume('k1')   // t=0, empty

      jest.setSystemTime(400)
      await bucket.tryConsume('k1')   // still denied at t=400 (0.4 tokens)

      jest.setSystemTime(1400)        // 1000ms after the denied call at t=400
      // At t=400 the bucket had 0.4 tokens → after another 1000ms: 0.4+1.0=1.4 → ≥1
      const r = await bucket.tryConsume('k1')
      expect(r.allowed).toBe(true)
    })
  })

  // ── 4. Constructor validation ───────────────────────────────────────────

  describe('constructor validation', () => {
    test('throws RangeError for capacity ≤ 0', () => {
      const store = new MemoryStore()
      expect(() => new TokenBucket(store, { capacity: 0, refillRate: 0.01 }))
        .toThrow(RangeError)
    })

    test('throws RangeError for refillRate ≤ 0', () => {
      const store = new MemoryStore()
      expect(() => new TokenBucket(store, { capacity: 10, refillRate: 0 }))
        .toThrow(RangeError)
    })
  })
})
