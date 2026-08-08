'use strict'

/**
 * rateLimit — Express middleware (step 2 of the protected route chain).
 *
 * Calls tryConsume() on the key's bound limiter.  If the request is
 * allowed, it sets informational headers and calls next().  If denied,
 * it returns HTTP 429 with a Retry-After header (RFC 6585).
 *
 * Headers always set (even on 200 responses):
 *   X-RateLimit-Limit      – configured limit for this key's tier
 *   X-RateLimit-Remaining  – capacity left after this request
 *   X-RateLimit-Algorithm  – which algorithm is active for this key
 *
 * Header set only on 429:
 *   Retry-After            – seconds until the client may retry (integer,
 *                            per RFC 7231 §7.1.3)
 *
 * Depends on authenticate() having run first (needs req.apiKey + req.keyRecord).
 */
async function rateLimit(req, res, next) {
  const { apiKey, keyRecord } = req

  const result = await keyRecord.limiter.tryConsume(apiKey)

  // Informational rate-limit headers (mirroring GitHub / Stripe conventions)
  res.set('X-RateLimit-Limit',     String(keyRecord.limit))
  res.set('X-RateLimit-Remaining', String(result.remaining))
  res.set('X-RateLimit-Algorithm', keyRecord.algorithm)

  if (!result.allowed) {
    // RFC 7231: Retry-After must be an integer number of seconds
    const retryAfterSecs = Math.ceil(result.retryAfter / 1000)
    res.set('Retry-After', String(retryAfterSecs))

    return res.status(429).json({
      error:      'Too Many Requests',
      message:    `Rate limit exceeded (${keyRecord.limit} req / ${keyRecord.windowMs / 1000}s on the ${keyRecord.tier} tier).`,
      retryAfter: retryAfterSecs,
    })
  }

  next()
}

module.exports = { rateLimit }
