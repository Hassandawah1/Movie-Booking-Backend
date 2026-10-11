const helmet = require("helmet")


function getSecurityHeaders() {
  const isProduction = process.env.NODE_ENV === "production"

  
  const helmetConfig = {
    
    dnsPrefetchControl: {
      allow: false
    },
    
    frameguard: {
      action: "sameorigin"
    },
    
    contentTypeOptions: true,
    
    hidePoweredBy: true,
    
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin"
    },
    
    xssFilter: true,
    
    ieNoOpen: true,
    
    hsts: isProduction
      ? {
          maxAge: 31536000, 
          includeSubDomains: true,
          preload: true
        }
      : false,
    
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

  
  return helmet(helmetConfig)
}

module.exports = getSecurityHeaders