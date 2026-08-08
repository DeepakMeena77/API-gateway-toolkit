'use strict'

const { Router } = require('express')
const { computeAnalytics } = require('../analytics')

const router = Router()

/**
 * GET /analytics
 * GET /analytics?window=30   (look-back in minutes, 1–60, default 60)
 *
 * Returns aggregated statistics from the Redis log stream.
 * Public admin endpoint — add authentication before production use.
 *
 * Response shape:
 * {
 *   window:           "last 60 minutes",
 *   generatedAt:      "2026-07-21T19:20:00.000Z",
 *   totalRequests:    1847,
 *   allowedRequests:  1700,
 *   blockedRequests:  147,
 *   blockRate:        "7.96%",
 *   avgLatencyMs:     3,
 *   requestsPerMinute: [
 *     { minute: "18:21", ts: 1721575260000, requests: 28, blocked: 2 },
 *     ...  (60 buckets, oldest → newest)
 *   ],
 *   topKeys: [
 *     { key: "sk_...", tier: "pro", algorithm: "token-bucket",
 *       requests: 900, blocked: 50, blockRate: "5.56%" },
 *     ...  (up to 5 entries)
 *   ]
 * }
 */
router.get('/', async (req, res, next) => {
  try {
    // ?window=N  where N is look-back in minutes (1–60)
    const rawWindow = parseInt(req.query.window ?? '60', 10)
    const windowMinutes = Number.isFinite(rawWindow)
      ? Math.max(1, Math.min(rawWindow, 60))
      : 60
    const windowMs = windowMinutes * 60_000

    const stats = await computeAnalytics({ windowMs })
    res.json(stats)
  } catch (err) {
    next(err)
  }
})

module.exports = router
