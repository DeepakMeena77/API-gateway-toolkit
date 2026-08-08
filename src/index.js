'use strict'

/**
 * Public API of the rate-limiter-core package.
 *
 * Usage:
 *   const { MemoryStore, TokenBucket, SlidingWindowCounter } = require('.')
 *
 *   const store  = new MemoryStore()
 *   const tb     = new TokenBucket(store, { capacity: 10, refillRate: 10 / 1000 })
 *   const sw     = new SlidingWindowCounter(store, { windowMs: 60_000, limit: 100 })
 *
 *   // Both limiters share the same interface
 *   const result = await tb.tryConsume('api-key-abc')
 *   // result = { allowed: true, remaining: 9 }
 */
const { Store, MemoryStore }           = require('./store')
const { RateLimiter }                  = require('./rate-limiter')
const { TokenBucket }                  = require('./token-bucket')
const { SlidingWindowCounter }         = require('./sliding-window')

module.exports = { Store, MemoryStore, RateLimiter, TokenBucket, SlidingWindowCounter }
