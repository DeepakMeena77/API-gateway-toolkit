'use strict'

const { MemoryStore }           = require('../src/store')
const { SlidingWindowCounter }  = require('../src/sliding-window')

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Default: windowMs=1 000 ms, limit=3.
 */
function setup({ windowMs = 1000, limit = 3 } = {}) {
  const store   = new MemoryStore()
  const limiter = new SlidingWindowCounter(store, { windowMs, limit })
  return { store, limiter }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SlidingWindowCounter', () => {

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 })  // t = 0 ms
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // ── 1. Normal allow / deny ──────────────────────────────────────────────

  describe('normal allow / deny', () => {
    test('allows the first request on a fresh key', async () => {
      const { limiter } = setup()
      const r = await limiter.tryConsume('k1')
      expect(r.allowed).toBe(true)
    })

    test('returns correct remaining count after each consume', async () => {
      const { limiter } = setup({ limit: 5 })
      const r1 = await limiter.tryConsume('k1')
      expect(r1.remaining).toBe(4)
      const r2 = await limiter.tryConsume('k1')
      expect(r2.remaining).toBe(3)
    })

    test('allows exactly `limit` requests then denies', async () => {
      const { limiter } = setup({ limit: 3 })
      for (let i = 0; i < 3; i++) {
        const r = await limiter.tryConsume('k1')
        expect(r.allowed).toBe(true)
      }
      const denied = await limiter.tryConsume('k1')
      expect(denied.allowed).toBe(false)
      expect(denied.remaining).toBe(0)
    })

    test('denied result carries a positive retryAfter', async () => {
      const { limiter } = setup({ limit: 1 })
      await limiter.tryConsume('k1')  // fills the window
      const r = await limiter.tryConsume('k1')
      expect(r.allowed).toBe(false)
      expect(typeof r.retryAfter).toBe('number')
      expect(r.retryAfter).toBeGreaterThan(0)
    })

    test('different keys are completely independent', async () => {
      const { limiter } = setup({ limit: 1 })
      const rA = await limiter.tryConsume('keyA')
      const rB = await limiter.tryConsume('keyB')
      expect(rA.allowed).toBe(true)
      expect(rB.allowed).toBe(true)  // separate window per key

      const rA2 = await limiter.tryConsume('keyA')
      expect(rA2.allowed).toBe(false)
    })
  })

  // ── 2. Burst behavior ───────────────────────────────────────────────────

  describe('burst behavior', () => {
    test('handles a rapid burst — allows `limit`, denies the rest', async () => {
      const { limiter } = setup({ limit: 3 })
      const results = []
      for (let i = 0; i < 6; i++) {
        results.push(await limiter.tryConsume('k1'))
      }
      expect(results.filter(r =>  r.allowed)).toHaveLength(3)
      expect(results.filter(r => !r.allowed)).toHaveLength(3)
    })

    test('remaining counts down correctly during a burst', async () => {
      const { limiter } = setup({ limit: 4 })
      const values = []
      for (let i = 0; i < 4; i++) {
        const r = await limiter.tryConsume('k1')
        values.push(r.remaining)
      }
      expect(values).toEqual([3, 2, 1, 0])
    })

    test('retryAfter equals time until oldest timestamp leaves the window', async () => {
      const { limiter } = setup({ windowMs: 1000, limit: 1 })

      jest.setSystemTime(500)
      await limiter.tryConsume('k1')  // timestamp recorded at t=500

      jest.setSystemTime(700)         // 200ms later, still in window
      const r = await limiter.tryConsume('k1')

      expect(r.allowed).toBe(false)
      // Oldest ts = 500. Window expires at 500 + 1000 = 1500. Now = 700.
      // retryAfter = 1500 - 700 = 800 ms
      expect(r.retryAfter).toBe(800)
    })
  })

  // ── 3. Window boundary behavior ─────────────────────────────────────────

  describe('window boundary behavior', () => {
    /**
     * Key semantic: timestamps are evicted when t_stored <= windowStart.
     * windowStart = now - windowMs
     * The filter is: t > windowStart  (strict >)
     * So a timestamp at exactly windowStart is considered expired.
     */

    test('allows a request once the oldest timestamp slides out', async () => {
      const { limiter } = setup({ windowMs: 1000, limit: 2 })

      // t=0: fill the window
      await limiter.tryConsume('k1')
      await limiter.tryConsume('k1')

      // t=999: windowStart = -1, both timestamps (0,0) > -1 → still active
      jest.setSystemTime(999)
      expect((await limiter.tryConsume('k1')).allowed).toBe(false)

      // t=1001: windowStart = 1, both timestamps (0,0) are NOT > 1 → evicted
      jest.setSystemTime(1001)
      expect((await limiter.tryConsume('k1')).allowed).toBe(true)
    })

    test('timestamp exactly at windowStart (t > windowStart is FALSE) is evicted', async () => {
      // Boundary: timestamp=0, now=1000, windowStart=0.  0 > 0 is false → evicted.
      const { limiter } = setup({ windowMs: 1000, limit: 1 })

      // Record a request at t=0
      await limiter.tryConsume('k1')

      // Move to t=1000; windowStart = 0.  The timestamp (0) is NOT > 0 → evicted.
      jest.setSystemTime(1000)
      const r = await limiter.tryConsume('k1')
      expect(r.allowed).toBe(true)
    })

    test('timestamp 1 ms inside the window is still counted', async () => {
      const { limiter } = setup({ windowMs: 1000, limit: 1 })

      jest.setSystemTime(1)
      await limiter.tryConsume('k1')  // ts = 1

      // t=1000: windowStart = 0.  ts=1 > 0 → still active
      jest.setSystemTime(1000)
      const r = await limiter.tryConsume('k1')
      expect(r.allowed).toBe(false)
    })

    test('timestamp slides out 1 ms after its expiry point', async () => {
      const { limiter } = setup({ windowMs: 1000, limit: 1 })

      jest.setSystemTime(1)
      await limiter.tryConsume('k1')  // ts = 1, expires at 1 + 1000 = 1001

      // t=1001: windowStart = 1.  ts=1 is NOT > 1 → evicted
      jest.setSystemTime(1001)
      const r = await limiter.tryConsume('k1')
      expect(r.allowed).toBe(true)
    })

    test('multiple requests spread across the window expire independently', async () => {
      const { limiter } = setup({ windowMs: 1000, limit: 3 })

      jest.setSystemTime(0)
      await limiter.tryConsume('k1')   // ts=0

      jest.setSystemTime(300)
      await limiter.tryConsume('k1')   // ts=300

      jest.setSystemTime(600)
      await limiter.tryConsume('k1')   // ts=600 — window full

      // t=1001: windowStart=1. ts=0 evicted. ts=300 and ts=600 still active.
      // Active count = 2, limit = 3 → allowed
      jest.setSystemTime(1001)
      const r = await limiter.tryConsume('k1')
      expect(r.allowed).toBe(true)
      expect(r.remaining).toBe(0)  // 2 active + 1 new = 3 = limit
    })

    test('fully expired window resets the counter for a key', async () => {
      const { limiter } = setup({ windowMs: 1000, limit: 3 })

      // Fill the window at t=0
      await limiter.tryConsume('k1')
      await limiter.tryConsume('k1')
      await limiter.tryConsume('k1')

      // 1001ms later: all timestamps have slid out
      jest.setSystemTime(1001)
      for (let i = 0; i < 3; i++) {
        const r = await limiter.tryConsume('k1')
        expect(r.allowed).toBe(true)
      }
    })
  })

  // ── 4. Constructor validation ───────────────────────────────────────────

  describe('constructor validation', () => {
    test('throws RangeError for windowMs ≤ 0', () => {
      const store = new MemoryStore()
      expect(() => new SlidingWindowCounter(store, { windowMs: 0, limit: 5 }))
        .toThrow(RangeError)
    })

    test('throws RangeError for limit ≤ 0', () => {
      const store = new MemoryStore()
      expect(() => new SlidingWindowCounter(store, { windowMs: 1000, limit: 0 }))
        .toThrow(RangeError)
    })

    test('throws RangeError for non-integer limit', () => {
      const store = new MemoryStore()
      expect(() => new SlidingWindowCounter(store, { windowMs: 1000, limit: 2.5 }))
        .toThrow(RangeError)
    })
  })
})
