'use strict'

const { Router } = require('express')
const { issueKey, listKeys, TIERS } = require('../key-registry')

const router = Router()

// ── POST /keys ──────────────────────────────────────────────────────────────
/**
 * Issue a new API key.
 *
 * Body (JSON, all optional):
 *   tier      string  'free' | 'pro'              (default: 'free')
 *   algorithm string  'sliding-window' | 'token-bucket' (default: 'sliding-window')
 *
 * Returns 201 with the new key and its configuration.
 * The key is shown only once — store it safely.
 */
router.post('/', (req, res) => {
  const { tier = 'free', algorithm = 'sliding-window' } = req.body ?? {}

  try {
    const record = issueKey({ tier, algorithm })
    return res.status(201).json({
      key:       record.key,
      tier:      record.tier,
      algorithm: record.algorithm,
      limit:     record.limit,
      windowMs:  record.windowMs,
      createdAt: record.createdAt,
      _note:     'Store this key securely — it will not be shown again.',
    })
  } catch (err) {
    return res.status(400).json({ error: 'Bad Request', message: err.message })
  }
})

// ── GET /keys ───────────────────────────────────────────────────────────────
/**
 * List all issued keys (admin endpoint — no auth in this in-memory version).
 * Does NOT return limiter internals, only key metadata.
 */
router.get('/', (_req, res) => {
  return res.json({ keys: listKeys(), total: listKeys().length })
})

// ── GET /keys/tiers ─────────────────────────────────────────────────────────
/**
 * Returns the available tiers and their rate-limit configurations.
 * Useful for documentation / client-side UX.
 */
router.get('/tiers', (_req, res) => {
  const formatted = Object.entries(TIERS).map(([name, cfg]) => ({
    name,
    limit:     cfg.limit,
    windowMs:  cfg.windowMs,
    windowSec: cfg.windowMs / 1000,
  }))
  return res.json({ tiers: formatted })
})

module.exports = router
