#!/usr/bin/env node
'use strict'

/**
 * load-test.js — Cross-instance rate-limit proof
 * ================================================
 * Uses Node's built-in http module only (zero npm install required).
 *
 * WHAT THIS PROVES
 * ─────────────────
 * With two app instances behind nginx (round-robin), a naive in-process
 * counter would give EACH instance its own bucket.  A free-tier key
 * (60 req/min) would then allow up to 120 requests in total — 60 per
 * instance — defeating the purpose of the limit.
 *
 * Because both instances use the SAME Redis for rate-limit state (via
 * Lua scripts), the global counter is shared.  Sending 100 requests
 * should allow exactly 60 and block the remaining 40, regardless of
 * which instance handled each one.
 *
 * USAGE
 *   node load-test.js [options]
 *
 * ENVIRONMENT VARIABLES (all optional)
 *   TARGET     Base URL of the load balancer   default: http://localhost:8080
 *   API_KEY    API key to use                  default: sk_loadtest
 *   ENDPOINT   Protected route to hit          default: /api/ping
 *   TOTAL      Total requests to fire          default: 100
 *   CONCURR    Max simultaneous connections    default: 25
 *   TIER_LIMIT Expected allow limit (for pass/ default: 60
 *              fail verdict)
 *
 * EXAMPLE — standard demo (should show ~60 allowed, ~40 blocked):
 *   node load-test.js
 *
 * EXAMPLE — aim at a single instance to see it would allow all 60 alone:
 *   TARGET=http://localhost:3001 node load-test.js
 */

const http  = require('http')
const https = require('https')
const { URL } = require('url')

// ── Configuration ─────────────────────────────────────────────────────────
const TARGET     = process.env.TARGET     || 'http://localhost:8080'
const API_KEY    = process.env.API_KEY    || 'sk_loadtest'
const ENDPOINT   = process.env.ENDPOINT   || '/api/ping'
const TOTAL      = parseInt(process.env.TOTAL      || '100', 10)
const CONCURR    = parseInt(process.env.CONCURR    || '25',  10)
const TIER_LIMIT = parseInt(process.env.TIER_LIMIT || '60',  10)

// ── HTTP helper ───────────────────────────────────────────────────────────
/**
 * Make one GET request and resolve with { status, latencyMs, servedBy }.
 * servedBy comes from the X-Served-By header that Express sets
 * (process.env.INSTANCE_NAME on each container).
 *
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<{status: number, latencyMs: number, servedBy: string}>}
 */
function request(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const client  = isHttps ? https : http

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'GET',
      headers: {
        'X-API-Key':  apiKey,
        'Connection': 'keep-alive',
      },
    }

    const t0  = Date.now()
    const req = client.request(options, (res) => {
      // Drain the body so the socket is returned to the pool promptly.
      res.resume()
      res.on('end', () =>
        resolve({
          status:    res.statusCode,
          latencyMs: Date.now() - t0,
          servedBy:  res.headers['x-served-by'] || 'unknown',
        })
      )
    })

    req.on('error', reject)
    req.setTimeout(10_000, () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })
    req.end()
  })
}

// ── Concurrency pool ──────────────────────────────────────────────────────
/**
 * Run an array of async task functions with at most `concurrency` running
 * simultaneously, collecting all results in order.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @returns {Promise<T[]>}
 */
async function pool(tasks, concurrency) {
  const results = new Array(tasks.length)
  let next = 0

  async function worker() {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    worker
  )
  await Promise.all(workers)
  return results
}

// ── Formatting helpers ────────────────────────────────────────────────────
const col  = (s, w) => String(s).padStart(w)
const line = (ch = '─', w = 62) => ch.repeat(w)

function pct(n, total) {
  if (total === 0) return '  0.0%'
  return (n / total * 100).toFixed(1).padStart(5) + '%'
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const fullUrl = TARGET.replace(/\/$/, '') + ENDPOINT

  console.log('\n' + line('═'))
  console.log('  Rate-Limiter Cross-Instance Load Test')
  console.log(line('═'))
  console.log(`  Target      ${fullUrl}`)
  console.log(`  API key     ${API_KEY}`)
  console.log(`  Requests    ${TOTAL} total, ${CONCURR} concurrent`)
  console.log(`  Tier limit  ${TIER_LIMIT} req / min (free tier)`)
  console.log(line())
  console.log()
  process.stdout.write(`  Firing ${TOTAL} requests`)

  const tasks = Array.from({ length: TOTAL }, () =>
    async () => {
      const r = await request(fullUrl, API_KEY)
      process.stdout.write(r.status === 200 ? '.' : 'X')
      return r
    }
  )

  const wallStart = Date.now()
  let results

  try {
    results = await pool(tasks, CONCURR)
  } catch (err) {
    console.error('\n\n  Fatal:', err.message)
    console.error('  Is the gateway running?  docker compose up --build')
    process.exit(1)
  }

  const wallMs = Date.now() - wallStart
  console.log('\n')

  // ── Aggregate by status ───────────────────────────────────────────────
  const allowed = results.filter(r => r.status === 200).length
  const blocked = results.filter(r => r.status === 429).length
  const errors  = results.filter(r => r.status !== 200 && r.status !== 429)

  // ── Latency percentiles ───────────────────────────────────────────────
  const lats = results.map(r => r.latencyMs).sort((a, b) => a - b)
  const p  = (frac) => lats[Math.max(0, Math.floor(lats.length * frac) - 1)]

  // ── Per-instance distribution ─────────────────────────────────────────
  const instanceMap = {}
  for (const r of results) {
    instanceMap[r.servedBy] = (instanceMap[r.servedBy] || 0) + 1
  }

  // ── Print results ─────────────────────────────────────────────────────
  console.log(line())
  console.log('  RESULTS')
  console.log(line())
  console.log(`  Total sent     ${col(TOTAL, 6)}`)
  console.log(`  Allowed (200)  ${col(allowed, 6)}   ${pct(allowed, TOTAL)}`)
  console.log(`  Blocked (429)  ${col(blocked, 6)}   ${pct(blocked, TOTAL)}`)
  if (errors.length) {
    const codes = [...new Set(errors.map(r => r.status))].join(', ')
    console.log(`  Other errors   ${col(errors.length, 6)}   (status: ${codes})`)
  }
  console.log()
  console.log('  LATENCY (ms)')
  console.log(line())
  console.log(`  p50  ${col(p(0.50), 6)}    p95  ${col(p(0.95), 6)}    p99  ${col(p(0.99), 6)}    max  ${col(p(1.00), 6)}`)
  console.log()
  console.log(`  Throughput  ${(TOTAL / (wallMs / 1000)).toFixed(0)} req/s  over ${wallMs}ms wall time`)
  console.log()
  console.log('  PER-INSTANCE DISTRIBUTION')
  console.log(line())
  for (const [inst, count] of Object.entries(instanceMap).sort()) {
    console.log(`  ${inst.padEnd(20)} ${col(count, 4)} requests   ${pct(count, TOTAL)}`)
  }

  // ── Verdict ───────────────────────────────────────────────────────────
  console.log()
  console.log(line())
  console.log('  VERDICT')
  console.log(line())

  const withinLimit = allowed <= TIER_LIMIT

  if (withinLimit && blocked > 0) {
    console.log(`  ✅  PASS — Redis shared counter held across instances.`)
    console.log(`      Allowed ${allowed} ≤ tier limit ${TIER_LIMIT}.  Blocked ${blocked} correctly.`)
    console.log()
    console.log('  If each instance had its OWN in-memory counter, with')
    console.log(`  ${Object.keys(instanceMap).length} instances and ${TIER_LIMIT} req/min limit, up to ${Object.keys(instanceMap).length * TIER_LIMIT} would`)
    console.log('  have been allowed.  Redis brings that down to exactly')
    console.log(`  ${TIER_LIMIT}, proving global enforcement.`)
  } else if (blocked === 0 && allowed < TIER_LIMIT) {
    console.log('  ℹ️  INFO — No requests were blocked.')
    console.log(`      Only ${allowed} requests reached the server (< limit ${TIER_LIMIT}).`)
    console.log(`      Increase TOTAL beyond ${TIER_LIMIT} to trigger blocking.`)
    console.log(`      Example: TOTAL=100 node load-test.js`)
  } else if (!withinLimit) {
    console.log(`  ❌  FAIL — ${allowed} requests were allowed, exceeding the tier limit of ${TIER_LIMIT}.`)
    console.log('      Check that REDIS_URL is the same for all app instances')
    console.log('      and that Redis is reachable from both containers.')
  } else {
    console.log(`  ⚠️  UNEXPECTED — allowed=${allowed}, blocked=${blocked}`)
    console.log('      Check the gateway logs for errors.')
  }

  console.log(line('═') + '\n')
  process.exit(withinLimit ? 0 : 1)
}

main().catch(err => {
  console.error('\n  Unhandled error:', err.message)
  process.exit(1)
})
