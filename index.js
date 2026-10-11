const dns = require("dns")
const dotenv = require("dotenv")
dotenv.config()

try {
  dns.setServers(["8.8.8.8", "8.8.4.4"])
} catch (e) {
  
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


const corsOptions = {
  origin: allowedOrigins,
  credentials: true
}
app.use(cors(corsOptions))


app.use(requestIdMiddleware)


app.use(getSecurityHeaders())


app.use(express.urlencoded({ extended: true }))
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf
    }
  })
)


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


app.use((req, res, next) => {
  const startTime = Date.now()

  
  console.info("Incoming request", {
    method: req.method,
    url: req.originalUrl,
    id: req.id
  })

  
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



app.use("/api/users", authRateLimiter)

app.use("/api/payments", paymentRateLimiter)

app.use("/api/movies/search", movieSearchRateLimiter)

app.use(apiRateLimiter)


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


app.get("/api/health", (req, res) => {
    console.log("Health route hit");
  res.status(200).json({
    success: true,
    status: "ok"
  })
})


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


app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Welcome to the Movie Booking API"
  })
})


app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found"
  })
})


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

  
  const shutdown = async (signal) => {
    console.info(`Received ${signal}. Starting graceful shutdown...`)

    
    server.close(async (err) => {
      if (err) {
        console.error("Error closing server:", err.message)
        process.exit(1)
      }

      console.info("HTTP server closed")

      
      try {
        await mongoose.disconnect()
        console.info("MongoDB connection closed")
      } catch (err) {
        console.error("Error closing MongoDB connection:", err.message)
      }

      
      console.info("Grace shutdown completed")
      process.exit(0)
    })

    
    setTimeout(() => {
      console.warn("Force shutting down after timeout")
      process.exit(1)
    }, 10000) 
  }

  
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT")) 

  
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", { promise, reason })
    
  })

  process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err)
    
    shutdown("UNCATCHED_EXCEPTION")
  })
}

module.exports = app