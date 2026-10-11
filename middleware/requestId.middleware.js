const crypto = require("crypto")


function requestIdMiddleware(req, res, next) {
  
  const requestId =
    req.headers["x-request-id"] ||
    req.headers["X-Request-ID"] ||
    req.headers["request-id"] ||
    
    `req_${crypto.randomBytes(16).toString("hex")}`

  
  req.id = requestId

  
  res.setHeader("X-Request-ID", requestId)
  res.setHeader("access-control-expose-headers", "X-Request-ID")

  
  if (res.locals) {
    res.locals.requestId = requestId
  }

  next()
}

module.exports = requestIdMiddleware