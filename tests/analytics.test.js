'use strict'

/**
 * Unit tests for the analytics aggregation logic.
 *
 * We mock getRecentLogs() so these tests run entirely in-process with
 * no Redis dependency.  The tests verify the aggregation math precisely.
 */

// Mock the logger module before any require() of analytics.js
jest.mock('../src/logger', () => ({
  log:            jest.fn().mockResolvedValue(undefined),
  getRecentLogs:  jest.fn(),
  STREAM_KEY:     'rl:logs',
}))

// Mock key-registry so lookup() returns predictable tier data
jest.mock('../src/key-registry', () => ({
  lookup: jest.fn((key) => {
    const records = {
      'sk_alpha': { tier: 'free', algorithm: 'sliding-window' },
      'sk_beta':  { tier: 'pro',  algorithm: 'token-bucket'   },
    }
    return records[key] ?? null
  }),
  issueKey:  jest.fn(),
  listKeys:  jest.fn(() => []),
  TIERS:     { free: { limit: 60, windowMs: 60000 }, pro: { limit: 1000, windowMs: 60000 } },
}))

// Also mock redis so key-registry's require('./redis') doesn't throw
jest.mock('../src/redis', () => ({
  getClient: jest.fn(() => ({})),
  ping:      jest.fn().mockResolvedValue('PONG'),
  quit:      jest.fn().mockResolvedValue(undefined),
}))

const { getRecentLogs } = require('../src/logger')
const { computeAnalytics } = require('../src/analytics')

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = 1_721_577_600_000  // fixed reference point

/**
 * Build a fake log entry.
 */
function entry({ minsAgo = 0, apiKey = 'sk_alpha', allowed = true, latencyMs = 5 } = {}) {
  return {
    _id:      `${NOW - minsAgo * 60_000}-0`,
    ts:       NOW - minsAgo * 60_000,
    apiKey,
    method:   'GET',
    path:     '/api/ping',
    status:   allowed ? 200 : 429,
    allowed,
    latencyMs,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeAnalytics', () => {

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW })
    getRecentLogs.mockClear()
  })

  afterEach(() => jest.useRealTimers())

  // ── Totals ─────────────────────────────────────────────────────────────────

  test('returns zero totals when stream is empty', async () => {
    getRecentLogs.mockResolvedValue([])
    const result = await computeAnalytics()
    expect(result.totalRequests).toBe(0)
    expect(result.allowedRequests).toBe(0)
    expect(result.blockedRequests).toBe(0)
    expect(result.blockRate).toBe('0.00%')
    expect(result.avgLatencyMs).toBe(0)
    expect(result.topKeys).toHaveLength(0)
  })

  test('counts total, allowed, and blocked correctly', async () => {
    getRecentLogs.mockResolvedValue([
      entry({ allowed: true }),
      entry({ allowed: true }),
      entry({ allowed: false }),
    ])
    const result = await computeAnalytics()
    expect(result.totalRequests).toBe(3)
    expect(result.allowedRequests).toBe(2)
    expect(result.blockedRequests).toBe(1)
  })

  test('computes blockRate as a percentage string', async () => {
    getRecentLogs.mockResolvedValue([
      entry({ allowed: true }),
      entry({ allowed: false }),
    ])
    const result = await computeAnalytics()
    expect(result.blockRate).toBe('50.00%')
  })

  test('computes avgLatencyMs as rounded mean', async () => {
    getRecentLogs.mockResolvedValue([
      entry({ latencyMs: 3 }),
      entry({ latencyMs: 7 }),
    ])
    const result = await computeAnalytics()
    expect(result.avgLatencyMs).toBe(5)  // (3+7)/2 = 5
  })

  // ── Requests per minute ────────────────────────────────────────────────────

  test('requestsPerMinute has 60 buckets for a 60-minute window', async () => {
    getRecentLogs.mockResolvedValue([])
    const result = await computeAnalytics({ windowMs: 60 * 60_000 })
    expect(result.requestsPerMinute).toHaveLength(60)
  })

  test('requestsPerMinute has N buckets for an N-minute window', async () => {
    getRecentLogs.mockResolvedValue([])
    const result = await computeAnalytics({ windowMs: 10 * 60_000 })
    expect(result.requestsPerMinute).toHaveLength(10)
  })

  test('places an entry into the correct minute bucket', async () => {
    // One entry 5 minutes ago → should land in bucket index (60-1-5) = 54
    getRecentLogs.mockResolvedValue([entry({ minsAgo: 5 })])
    const result = await computeAnalytics({ windowMs: 60 * 60_000 })
    const buckets = result.requestsPerMinute

    // Bucket at index 54 (5 mins ago from the most recent)
    expect(buckets[54].requests).toBe(1)
    // All other buckets should be 0
    const nonZero = buckets.filter(b => b.requests > 0)
    expect(nonZero).toHaveLength(1)
  })

  test('newest entry (minsAgo=0) lands in the last bucket (index 59)', async () => {
    getRecentLogs.mockResolvedValue([entry({ minsAgo: 0 })])
    const result = await computeAnalytics({ windowMs: 60 * 60_000 })
    const buckets = result.requestsPerMinute
    expect(buckets[59].requests).toBe(1)
  })

  test('oldest boundary entry (minsAgo=59) lands in bucket index 0', async () => {
    getRecentLogs.mockResolvedValue([entry({ minsAgo: 59 })])
    const result = await computeAnalytics({ windowMs: 60 * 60_000 })
    expect(result.requestsPerMinute[0].requests).toBe(1)
  })

  test('blocked count per bucket is tracked independently', async () => {
    getRecentLogs.mockResolvedValue([
      entry({ minsAgo: 0, allowed: true  }),
      entry({ minsAgo: 0, allowed: false }),
    ])
    const result = await computeAnalytics({ windowMs: 60 * 60_000 })
    const lastBucket = result.requestsPerMinute[59]
    expect(lastBucket.requests).toBe(2)
    expect(lastBucket.blocked).toBe(1)
  })

  test('requestsPerMinute buckets have HH:MM labels (UTC)', async () => {
    getRecentLogs.mockResolvedValue([])
    const result = await computeAnalytics()
    for (const bucket of result.requestsPerMinute) {
      expect(bucket.minute).toMatch(/^\d{2}:\d{2}$/)
    }
  })

  // ── Top keys ───────────────────────────────────────────────────────────────

  test('topKeys are sorted by request count descending', async () => {
    getRecentLogs.mockResolvedValue([
      entry({ apiKey: 'sk_alpha' }),
      entry({ apiKey: 'sk_beta'  }),
      entry({ apiKey: 'sk_beta'  }),
    ])
    const result = await computeAnalytics()
    expect(result.topKeys[0].key).toBe('sk_beta')
    expect(result.topKeys[1].key).toBe('sk_alpha')
  })

  test('topKeys returns at most 5 entries', async () => {
    const entries = ['sk_a','sk_b','sk_c','sk_d','sk_e','sk_f'].map(k =>
      entry({ apiKey: k })
    )
    getRecentLogs.mockResolvedValue(entries)
    const result = await computeAnalytics()
    expect(result.topKeys.length).toBeLessThanOrEqual(5)
  })

  test('topKeys includes tier and algorithm from key-registry', async () => {
    getRecentLogs.mockResolvedValue([entry({ apiKey: 'sk_alpha' })])
    const result = await computeAnalytics()
    expect(result.topKeys[0].tier).toBe('free')
    expect(result.topKeys[0].algorithm).toBe('sliding-window')
  })

  test('topKeys shows unknown tier for unregistered keys', async () => {
    getRecentLogs.mockResolvedValue([entry({ apiKey: 'sk_unknown' })])
    const result = await computeAnalytics()
    expect(result.topKeys[0].tier).toBe('unknown')
    expect(result.topKeys[0].algorithm).toBe('unknown')
  })

  test('topKeys per-key blockRate is computed independently', async () => {
    getRecentLogs.mockResolvedValue([
      entry({ apiKey: 'sk_alpha', allowed: true  }),
      entry({ apiKey: 'sk_alpha', allowed: false }),
    ])
    const result = await computeAnalytics()
    const alpha = result.topKeys.find(k => k.key === 'sk_alpha')
    expect(alpha.requests).toBe(2)
    expect(alpha.blocked).toBe(1)
    expect(alpha.blockRate).toBe('50.00%')
  })

  // ── Metadata ───────────────────────────────────────────────────────────────

  test('window label reflects the windowMs parameter', async () => {
    getRecentLogs.mockResolvedValue([])
    const r30 = await computeAnalytics({ windowMs: 30 * 60_000 })
    expect(r30.window).toBe('last 30 minutes')
    const r60 = await computeAnalytics({ windowMs: 60 * 60_000 })
    expect(r60.window).toBe('last 60 minutes')
  })

  test('generatedAt is a valid ISO timestamp', async () => {
    getRecentLogs.mockResolvedValue([])
    const result = await computeAnalytics()
    expect(() => new Date(result.generatedAt)).not.toThrow()
    expect(new Date(result.generatedAt).getTime()).toBeGreaterThan(0)
  })
})
