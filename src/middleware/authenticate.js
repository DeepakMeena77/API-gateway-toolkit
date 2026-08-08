'use strict'

const { lookup } = require('../key-registry')

/**
 * authenticate — Express middleware (step 1 of the protected route chain).
 *
 * Reads the `X-API-Key` header, validates it against the registry, and
 * attaches two properties to `req` for downstream middleware:
 *   req.apiKey    {string}    — the raw key string (used as the limiter key)
 *   req.keyRecord {KeyRecord} — full record including the limiter instance
 *
 * Responds 401 and short-circuits if the key is missing or unknown.
 */
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key']

  if (!apiKey) {
    return res.status(401).json({
      error:   'Unauthorized',
      message: 'Missing X-API-Key header. Issue a key via POST /keys.',
    })
  }

  const record = lookup(apiKey)
  if (!record) {
    return res.status(401).json({
      error:   'Unauthorized',
      message: 'Invalid or unknown API key.',
    })
  }

  // Attach to req so rate-limit.js and route handlers can read without
  // hitting the registry a second time.
  req.apiKey    = apiKey
  req.keyRecord = record
  next()
}

module.exports = { authenticate }
