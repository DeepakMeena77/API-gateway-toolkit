'use strict'

/**
 * @fileoverview Request logging middleware.
 *
 * Attaches a res.on('finish') listener before handing control to the
 * rest of the middleware chain.  By the time 'finish' fires, all
 * downstream middleware (authenticate, rateLimit, route handler) have
 * completed, so req.apiKey and res.statusCode are fully resolved.
 *
 * PLACEMENT IN THE CHAIN
 * ──────────────────────
 * Mounted as the FIRST middleware in the /api chain:
 *
 *   /api  →  requestLogger  →  authenticate  →  rateLimit  →  router
 *
 * This placement means:
 *   - For an invalid key (401):  req.apiKey is undefined  → skipped
 *   - For a rate-limited key (429): req.apiKey is set, status=429 → logged
 *   - For a successful request:  req.apiKey is set, status=2xx → logged
 *
 * Anonymous 401s are intentionally NOT logged because they carry no
 * useful API-key context for rate-limit analytics.
 *
 * WHY res.on('finish') INSTEAD OF WRAPPING res.end?
 * ──────────────────────────────────────────────────
 * 'finish' fires exactly once when the response has been handed to the
 * OS network buffer, regardless of which middleware ended the chain.
 * Monkey-patching res.end() works but must handle all overloaded call
 * signatures (end(), end(data), end(data, encoding), end(data, enc, cb)).
 * 'finish' is the idiomatic, robust alternative.
 *
 * WHY FIRE-AND-FORGET?
 * ────────────────────
 * The log write happens after the response is already sent.  Awaiting
 * it inside the 'finish' handler would silently swallow any error
 * (async event listeners don't propagate rejections).  We use .catch()
 * to print the error without crashing and without adding latency for
 * the client.
 */

const { log } = require('../logger')

/**
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requestLogger(req, res, next) {
  const startMs = Date.now()

  res.on('finish', () => {
    // Skip unauthenticated requests — no API key context to log.
    if (!req.apiKey) return

    const latencyMs = Date.now() - startMs

    // Fire-and-forget: response is already sent, logging is best-effort.
    log({
      ts:        Date.now(),
      apiKey:    req.apiKey,
      method:    req.method,
      path:      req.path,
      status:    res.statusCode,
      allowed:   res.statusCode !== 429,
      latencyMs,
    }).catch(err =>
      console.error('[request-logger] write failed:', err.message)
    )
  })

  next()
}

module.exports = { requestLogger }
