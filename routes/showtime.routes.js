const express = require("express")
const router = express.Router()

const {
  createShowtime,
  getAllShowtimes,
  getShowtimesForMovie,
  getShowtimeById,
  getShowtimeSeats,
  updateShowtime,
  deleteShowtime
} = require("../controllers/showtime.controller")

const authenticateUser = require("../middleware/auth.middleware")
const authorizeAdmin = require("../middleware/admin.middleware")

// ─── Admin routes ─────────────────────────────────────────────────────────────

// POST /api/showtimes — create a new showtime
router.post("/", authenticateUser, authorizeAdmin, createShowtime)

// ─── Public routes ────────────────────────────────────────────────────────────

// GET /api/showtimes — list all (with optional filters)
router.get("/", getAllShowtimes)

// IMPORTANT: /movie/:movieId MUST come BEFORE /:id
// Otherwise Express will try to match "movie" as a MongoDB ObjectId
router.get("/movie/:movieId", getShowtimesForMovie)

// GET /api/showtimes/:showtimeId/seats — real-time seat availability & layout
router.get("/:showtimeId/seats", getShowtimeSeats)

// GET /api/showtimes/:id — single showtime
router.get("/:id", getShowtimeById)

// ─── Admin routes (by ID) ─────────────────────────────────────────────────────

// PUT /api/showtimes/:id — update showtime / cancel it
router.put("/:id", authenticateUser, authorizeAdmin, updateShowtime)

// DELETE /api/showtimes/:id — physical delete (pre-booking phase)
router.delete("/:id", authenticateUser, authorizeAdmin, deleteShowtime)

module.exports = router