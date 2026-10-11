const express = require("express")
const router = express.Router()

const {
  createBooking,
  getMyBookings,
  getBookingById,
  cancelBooking,
  getAllBookings
} = require("../controllers/booking.controller")

const authenticateUser = require("../middleware/auth.middleware")
const authorizeAdmin = require("../middleware/admin.middleware")

// ─── Protected Routes (All require authentication) ───────────────────────────

// POST /api/bookings — Reserve seats and create pending booking
router.post("/", authenticateUser, createBooking)

// GET /api/bookings/my — List logged-in user's bookings (MUST be before /:id)
router.get("/my", authenticateUser, getMyBookings)

// GET /api/bookings — List all bookings across the platform (Admin only)
router.get("/", authenticateUser, authorizeAdmin, getAllBookings)

// PATCH /api/bookings/:id/cancel — Cancel an unpaid booking
router.patch("/:id/cancel", authenticateUser, cancelBooking)

// GET /api/bookings/:id — Get details of a single booking (User own or Admin)
router.get("/:id", authenticateUser, getBookingById)

module.exports = router