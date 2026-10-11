const crypto = require("crypto")

/**
 * Request ID middleware for correlation
 * Generates or extracts request ID and adds it to request and response
 */
function requestIdMiddleware(req, res, next) {
  // Try to get request ID from header (if sent by client or proxy)
  const requestId =
    req.headers["x-request-id"] ||
    req.headers["X-Request-ID"] ||
    req.headers["request-id"] ||
    // Generate a new request ID if none provided
    `req_${crypto.randomBytes(16).toString("hex")}`

  // Attach request ID to request for logging and downstream use
  req.id = requestId

  // Set response header so client can correlate
  res.setHeader("X-Request-ID", requestId)
  res.setHeader("access-control-expose-headers", "X-Request-ID")

  // Add to locals for templating engines if used
  if (res.locals) {
    res.locals.requestId = requestId
  }

  next()
}

module.exports = requestIdMiddleware