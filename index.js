const dns = require("dns")
const dotenv = require("dotenv")
dotenv.config()

try {
  dns.setServers(["8.8.8.8", "8.8.4.4"])
} catch (e) {
  // Ignore in environments where setServers is restricted
}

const requestIdMiddleware = require("./middleware/requestId.middleware")
const getSecurityHeaders = require("./middleware/securityHeaders.middleware")
const { authRateLimiter, paymentRateLimiter, apiRateLimiter, movieSearchRateLimiter } = require("./middleware/rateLimit.middleware")

const express = require("express")
const app = express()
const mongoose = require("mongoose")
const cors = require("cors")
const URI = process.env.MONGODB_URI
const allowedOrigins = [
  ...(process.env.FRONTEND_URL || "").split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean),
  "https://movie-booking-flax-chi.vercel.app",
  "http://localhost:5173",
  "http://localhost:5175"
]

let connectionPromise
const connectToDatabase = async () => {
  if (mongoose.connection.readyState === 1) return
  if (!URI) throw new Error("MONGODB_URI environment variable is not set")

  if (!connectionPromise) {
    connectionPromise = mongoose.connect(URI, {
      maxPoolSize: 10,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000
    }).then(() => {
      console.info("Database connected successfully")
    }).finally(() => {
      connectionPromise = null
    })
  }

  await connectionPromise
}

// Middleware
const corsOptions = {
  origin: allowedOrigins,
  credentials: true
}
app.use(cors(corsOptions))

// Request ID middleware (should be early to capture ID for all subsequent logs)
app.use(requestIdMiddleware)

// Security headers
app.use(getSecurityHeaders())

// Body parsing middleware
app.use(express.urlencoded({ extended: true }))
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf
    }
  })
)

// Wait for MongoDB before allowing API routes to run.
app.use("/api", async (req, res, next) => {
  if (req.path === "/health" || req.path === "/ready") return next()

  try {
    await connectToDatabase()
    next()
  } catch (error) {
    console.error("Database unavailable for API request:", error.message)
    res.status(503).json({
      success: false,
      message: "Database unavailable. Please try again later."
    })
  }
})

// Request logging middleware (should come after requestId and security headers)
app.use((req, res, next) => {
  const startTime = Date.now()

  // Log incoming request
  console.info("Incoming request", {
    method: req.method,
    url: req.originalUrl,
    id: req.id
  })

  // Handle response finish
  res.on("finish", () => {
    const duration = Date.now() - startTime
    console.info("Request completed", {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      id: req.id
    })
  })

  // Handle response close (for aborted requests)
  res.on("close", () => {
    const duration = Date.now() - startTime
    console.info("Request closed", {
      method: req.method,
      url: req.originalUrl,
      duration: `${duration}ms`,
      id: req.id
    })
  })

  next()
})

// Apply rate limiting to specific routes
// Auth routes - stricter limiting
app.use("/api/users", authRateLimiter)
// Payment routes
app.use("/api/payments", paymentRateLimiter)
// Movie search routes
app.use("/api/movies/search", movieSearchRateLimiter)
// General API rate limiting
app.use(apiRateLimiter)

// Routes
const UserRouter = require("./routes/user.routes")
const MovieRouter = require("./routes/movie.routes")
const ScreenRouter = require("./routes/screen.routes")
const ShowtimeRouter = require("./routes/showtime.routes")
const BookingRouter = require("./routes/booking.routes")
const PaymentRouter = require("./routes/payment.routes")
const AdminRouter = require("./routes/admin.routes")

app.use("/api/users", UserRouter)
app.use("/api/movies", MovieRouter)
app.use("/api/screens", ScreenRouter)
app.use("/api/showtimes", ShowtimeRouter)
app.use("/api/bookings", BookingRouter)
app.use("/api/payments", PaymentRouter)
app.use("/api/admin", AdminRouter)

// Health check endpoint (liveness)
app.get("/api/health", (req, res) => {
    console.log("Health route hit");
  res.status(200).json({
    success: true,
    status: "ok"
  })
})

// Readiness endpoint (checks dependencies)
app.get("/api/ready", async (req, res) => {
  try {
    await connectToDatabase()
    res.status(200).json({
      success: true,
      status: "ok"
    })
  } catch (error) {
    console.error("Readiness check failed:", error)
    res.status(503).json({
      success: false,
      status: "service_unavailable",
      reason: "readiness_check_failed"
    })
  }
})

// Root
app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to the Movie Booking API"
  })
})

// 404 handler - ensure JSON response format
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found"
  })
})

// Global error handler - structured error logging
app.use((err, req, res, next) => {
  console.error("Server error:", {
    error: err,
    id: req.id,
    method: req.method,
    url: req.originalUrl
  })

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error"
  })
})

// Start server only when executed directly (not when required by tests)
if (require.main === module) {
  const PORT = process.env.PORT || 5000
  connectToDatabase().catch((error) => {
    console.error("Cannot connect to DB:", error.message)
  })

  const server = app.listen(PORT, (err) => {
    if (err) {
      console.error("Cannot start server at this time:", err.message)
    } else {
      console.info(`Server started on port ${PORT}`)
    }
  })

  // Graceful shutdown handling
  const shutdown = async (signal) => {
    console.info(`Received ${signal}. Starting graceful shutdown...`)

    // 1. Stop accepting new connections
    server.close(async (err) => {
      if (err) {
        console.error("Error closing server:", err.message)
        process.exit(1)
      }

      console.info("HTTP server closed")

      // 2. Close MongoDB connection
      try {
        await mongoose.disconnect()
        console.info("MongoDB connection closed")
      } catch (err) {
        console.error("Error closing MongoDB connection:", err.message)
      }

      // Exit process after the connections have closed.
      console.info("Grace shutdown completed")
      process.exit(0)
    })

    // Force shutdown after timeout
    setTimeout(() => {
      console.warn("Force shutting down after timeout")
      process.exit(1)
    }, 10000) // 10 second timeout
  }

  // Listen for shutdown signals
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT")) // Ctrl+C

  // Handle unhandled rejections and exceptions
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", { promise, reason })
    // Don't exit here - let the process handle it naturally
  })

  process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err)
    // Don't exit immediately - allow cleanup to happen
    shutdown("UNCATCHED_EXCEPTION")
  })
}

module.exports = app