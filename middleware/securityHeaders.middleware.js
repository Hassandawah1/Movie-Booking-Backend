const helmet = require("helmet")

/**
 * Configure Helmet security headers based on environment
 * @returns {import('express').Middleware[]} Array of helmet middleware functions
 */
function getSecurityHeaders() {
  const isProduction = process.env.NODE_ENV === "production"

  // Base helmet configuration
  const helmetConfig = {
    // Set X-DNS-Prefetch-Control to control browser DNS prefetching
    dnsPrefetchControl: {
      allow: false
    },
    // Set X-Frame-Options to prevent clickjacking
    frameguard: {
      action: "sameorigin"
    },
    // Set X-Content-Type-Options to prevent MIME sniffing
    contentTypeOptions: true,
    // Disable X-Powered-By header
    hidePoweredBy: true,
    // Set Referrer Policy to control referrer information
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin"
    },
    // Set X-XSS-Protection (legacy but still useful for older browsers)
    xssFilter: true,
    // Prevent IE from opening untrusted HTML
    ieNoOpen: true,
    // HSTS (HTTP Strict Transport Security) - only in production over HTTPS
    hsts: isProduction
      ? {
          maxAge: 31536000, // 1 year
          includeSubDomains: true,
          preload: true
        }
      : false,
    // Content Security Policy - configure carefully to avoid breaking functionality
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            imgSrc: ["'self'", "data:", "https:"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'", "https://api.paystack.co"],
            frameSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: []
          }
        }
      : false
  }

  // Apply helmet with our configuration
  return helmet(helmetConfig)
}

module.exports = getSecurityHeaders