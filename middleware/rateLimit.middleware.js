const rateLimit = require("express-rate-limit")
const { ipKeyGenerator } = require("express-rate-limit")


function createRateLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000, 
    limit: options.limit || 100, 
    standardHeaders: true, 
    legacyHeaders: false, 
    skipFailedRequests: false, 
    skipSuccessfulRequests: false, 
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


const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, 
  limit: 5, 
  keyGenerator: (req) => {
    
    
    const identifier = req.body?.email || req.body?.username || ''
    return `${ipKeyGenerator(req.ip)}-${identifier}`
  }
})


const paymentRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, 
  limit: 10, 
  keyGenerator: (req) => {
    
    if (req.user && req.user._id) {
      return `user-${req.user._id}`
    }
    return ipKeyGenerator(req.ip)
  }
})


const apiRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, 
  limit: 100, 
})


const movieSearchRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, 
  limit: 20, 
  keyGenerator: (req) => {
    
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
