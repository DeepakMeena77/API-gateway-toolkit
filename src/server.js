'use strict'

/**
 * @fileoverview Express application entry point.
 *
 * Route map
 * ---------
 * PUBLIC (no auth)
 *   POST /keys          Issue a new API key
 *   GET  /keys          List all issued keys (admin)
 *   GET  /keys/tiers    View tier configurations
 *   GET  /analytics     Request statistics (last 1-60 min, default 60)
 *   GET  /analytics?window=N
 *
 * PROTECTED (X-API-Key header required)
 *   GET  /api/ping      Lightweight liveness check
 *   GET  /api/data      Sample data endpoint
 *
 * Middleware stack for protected routes:
 *   requestLogger -> authenticate -> rateLimit -> routeHandler
 *
 * Error responses
 *   401  Missing or invalid X-API-Key
 *   429  Rate limit exceeded  (+ Retry-After header)
 *   404  Unknown path
 *   500  Unexpected server error
 */

const express          = require('express')
const cors             = require('cors')
const os               = require('os')
const keysRouter       = require('./routes/keys')
const protectedRouter  = require('./routes/protected')
const analyticsRouter  = require('./routes/analytics')
const { authenticate } = require('./middleware/authenticate')
const { rateLimit }    = require('./middleware/rate-limit')
const { requestLogger }= require('./middleware/request-log')
const redis            = require('./redis')
const { seedRegistry } = require('./key-registry')

const app = express()

// ── Global middleware ────────────────────────────────────────────────────────
// Allow cross-origin requests from the dashboard static site.
// CORS_ORIGIN env var lets you lock this down to a specific origin in production.
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
}))
app.use(express.json())

// Tag every response with the instance name so the load test and logs
// can show which backend handled each request.
const INSTANCE = process.env.INSTANCE_NAME || os.hostname()
app.use((_req, res, next) => { res.set('X-Served-By', INSTANCE); next() })

// ── Public routes ────────────────────────────────────────────────────────────
app.use('/keys',      keysRouter)
app.use('/analytics', analyticsRouter)

// ── Protected routes ─────────────────────────────────────────────────────────
// requestLogger is first so res.on('finish') captures the final status
// code regardless of which middleware terminates the chain.
app.use('/api', requestLogger, authenticate, rateLimit, protectedRouter)

// ── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:   'Not Found',
    message: `No route matched ${req.method} ${req.path}`,
  })
})

// ── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err)
  res.status(500).json({ error: 'Internal Server Error' })
})

// ── Start (only when run directly, not when require()'d in tests) ─────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000

  // Verify Redis is reachable before accepting traffic.
  // Race the ping against a 25-second timeout so we fail fast if
  // the REDIS_URL is wrong rather than hanging indefinitely.
  const pingTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Redis ping timed out after 25 s — check REDIS_URL')), 25_000)
  )

  Promise.race([redis.ping(), pingTimeout])
    .then(() => {
      // Seed a known API key into every instance if SEED_KEY is provided.
      // Format: SEED_KEY=sk_mykey,tier,algorithm
      // Example: SEED_KEY=sk_loadtest,free,sliding-window
      //
      // This is necessary because the key registry is in-memory: a key
      // created through nginx lands on one instance only.  Seeding the
      // same value on every instance lets nginx round-robin freely.
      if (process.env.SEED_KEY) {
        const parts     = process.env.SEED_KEY.split(',')
        const keyValue  = parts[0].trim()
        const tier      = (parts[1] || 'free').trim()
        const algorithm = (parts[2] || 'sliding-window').trim()
        const rec       = seedRegistry(keyValue, tier, algorithm)
        console.log(`[registry] seeded key ${rec.key} (${rec.tier}/${rec.algorithm})`)
      }

      const server = app.listen(PORT, () => {
        console.log(`\n  Rate-limiter gateway  http://localhost:${PORT}\n`)
        console.log('  Public endpoints:')
        console.log('    POST /keys              - issue a new API key')
        console.log('    GET  /keys              - list all keys (admin)')
        console.log('    GET  /keys/tiers        - view tier configs')
        console.log('    GET  /analytics         - request statistics (last 60 min)')
        console.log('    GET  /analytics?window=N- request statistics (1-60 min)')
        console.log('\n  Protected endpoints (X-API-Key required):')
        console.log('    GET  /api/ping          - liveness check')
        console.log('    GET  /api/data          - sample data')
        console.log()
      })

      // Graceful shutdown: finish in-flight requests, then close Redis
      process.on('SIGTERM', () => {
        console.log('[server] SIGTERM received, shutting down...')
        server.close(async () => {
          await redis.quit()
          console.log('[server] shutdown complete')
          process.exit(0)
        })
      })
    })
    .catch((err) => {
      console.error('[startup] Redis ping failed:', err.message)
      console.error('[startup] Is Redis running? Set REDIS_URL env var if needed.')
      process.exit(1)
    })
}

module.exports = app   // export for integration tests
