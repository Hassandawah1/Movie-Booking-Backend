const rateLimit = require("express-rate-limit")
const { ipKeyGenerator } = require("express-rate-limit")

/**
 * Create a rate limiter with configurable options
 * @param {Object} options - Rate limit options
 * @returns {import('express').Middleware} Express middleware
 */
function createRateLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000, // 15 minutes default
    limit: options.limit || 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    skipFailedRequests: false, // Count failed requests as well
    skipSuccessfulRequests: false, // Count successful requests as well
    keyGenerator: (req) => {
      return ipKeyGenerator(req.ip)
    },
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        message: "Too many requests. Please try again later.",
        code: "RATE_LIMITED"
      })
    },
    ...options
  })
}

/**
 * Auth-specific rate limiter (stricter limits)
 */
const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5, // 5 attempts per window
  keyGenerator: (req) => {
    // For auth endpoints, also consider username/email in the body for more specific limiting
    // Use ipKeyGenerator for IP part to ensure IPv6 compatibility
    const identifier = req.body?.email || req.body?.username || ''
    return `${ipKeyGenerator(req.ip)}-${identifier}`
  }
})

/**
 * Payment-specific rate limiter
 */
const paymentRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10, // 10 payment attempts per hour
  keyGenerator: (req) => {
    // Limit by user ID if authenticated, otherwise by IP
    if (req.user && req.user._id) {
      return `user-${req.user._id}`
    }
    return ipKeyGenerator(req.ip)
  }
})

/**
 * General API rate limiter
 */
const apiRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // 100 requests per window
})

/**
 * Movie search rate limiter (if abuse-sensitive)
 */
const movieSearchRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20, // 20 searches per window
  keyGenerator: (req) => {
    // Limit by IP for movie search
    return ipKeyGenerator(req.ip)
  }
})

module.exports = {
  createRateLimiter,
  authRateLimiter,
  paymentRateLimiter,
  apiRateLimiter,
  movieSearchRateLimiter
}
