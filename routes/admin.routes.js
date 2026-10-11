const express = require("express")
const router = express.Router()

const {
  getDashboardSummary,
  getRevenueAnalytics,
  getRevenueTrend,
  getRecentBookings,
  getUpcomingShowtimes,
  getTopMovies,
  getBookingAnalytics,
  getPaymentAnalytics,
  getAllUsers,
  getUserById,
  updateUserRole,
  getShowtimeOccupancy,
  getShowtimeRevenue,
  getMoviePerformance,
  getScreenPerformance
} = require("../controllers/admin.controller")

const authenticateUser = require("../middleware/auth.middleware")
const authorizeAdmin = require("../middleware/admin.middleware")

// Apply Admin Protection to all admin routes
router.use(authenticateUser, authorizeAdmin)

// ─── Dashboard & Overview ────────────────────────────────────────────────────
router.get("/dashboard", getDashboardSummary)

// ─── Analytics ───────────────────────────────────────────────────────────────
router.get("/analytics/revenue", getRevenueAnalytics)
router.get("/analytics/revenue-trend", getRevenueTrend)
router.get("/analytics/top-movies", getTopMovies)
router.get("/analytics/bookings", getBookingAnalytics)
router.get("/analytics/payments", getPaymentAnalytics)

// ─── Operations & Activity ───────────────────────────────────────────────────
router.get("/bookings/recent", getRecentBookings)
router.get("/showtimes/upcoming", getUpcomingShowtimes)

// ─── Single Resource Performance & Occupancy ─────────────────────────────────
router.get("/showtimes/:id/occupancy", getShowtimeOccupancy)
router.get("/showtimes/:id/revenue", getShowtimeRevenue)
router.get("/movies/:id/performance", getMoviePerformance)
router.get("/screens/:id/performance", getScreenPerformance)

// ─── User Management ─────────────────────────────────────────────────────────
router.get("/users", getAllUsers)
router.get("/users/:id", getUserById)
router.patch("/users/:id/role", updateUserRole)

module.exports = router
