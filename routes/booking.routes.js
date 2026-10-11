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




router.post("/", authenticateUser, createBooking)


router.get("/my", authenticateUser, getMyBookings)


router.get("/", authenticateUser, authorizeAdmin, getAllBookings)


router.patch("/:id/cancel", authenticateUser, cancelBooking)


router.get("/:id", authenticateUser, getBookingById)

module.exports = router