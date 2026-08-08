'use strict'

const { Router } = require('express')

const router = Router()

// ── GET /api/ping ────────────────────────────────────────────────────────────
/**
 * Lightweight liveness probe.
 * Good for testing that auth + rate limiting work without any processing cost.
 *
 * Example response:
 *   { "message": "pong", "key": "sk_...", "tier": "free", "timestamp": "..." }
 */
router.get('/ping', (req, res) => {
  res.json({
    message:   'pong',
    key:       req.apiKey,
    tier:      req.keyRecord.tier,
    algorithm: req.keyRecord.algorithm,
    timestamp: new Date().toISOString(),
  })
})

// ── GET /api/data ────────────────────────────────────────────────────────────
/**
 * Simulates a more expensive protected resource.
 * Returns a small payload so there's something meaningful to rate-limit against.
 *
 * Example response:
 *   { "key": "sk_...", "tier": "pro", "records": [...], "generatedAt": "..." }
 */
router.get('/data', (req, res) => {
  // Dummy data — replace with real DB queries in a later sprint
  const records = Array.from({ length: 5 }, (_, i) => ({
    id:    i + 1,
    label: `item-${i + 1}`,
    value: parseFloat(Math.random().toFixed(4)),
  }))

  res.json({
    key:         req.apiKey,
    tier:        req.keyRecord.tier,
    algorithm:   req.keyRecord.algorithm,
    records,
    generatedAt: new Date().toISOString(),
  })
})

module.exports = router
