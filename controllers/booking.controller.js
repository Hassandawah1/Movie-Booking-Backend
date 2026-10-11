const mongoose = require("mongoose")
const User = require("../models/User.model")
const Booking = require("../models/Booking.model")
const Showtime = require("../models/Showtime.model")
const Movie = require("../models/Movie.model")
const Screen = require("../models/Screen.model")
const {
  generateBookingReference,
  isValidSeatLabel,
  releaseExpiredBookings
} = require("../utils/booking.util")
const { sendReservationEmail, sendCancellationEmail } = require("../services/email.service")


const VALID_BOOKING_STATUSES = ["pending-payment", "confirmed", "cancelled", "expired"]
const VALID_PAYMENT_STATUSES = ["unpaid", "paid", "failed", "refunded"]






const createBooking = async (req, res) => {
  let reservedSeats = []
  let targetShowtimeId = null

  try {
    const { showtimeId, seats } = req.body

    
    if (!showtimeId) {
      return res.status(400).json({ success: false, message: "showtimeId is required" })
    }

    if (!mongoose.isValidObjectId(showtimeId)) {
      return res.status(400).json({ success: false, message: "Invalid showtime ID format" })
    }

    if (!seats || !Array.isArray(seats) || seats.length === 0) {
      return res.status(400).json({
        success: false,
        message: "seats must be a non-empty array of seat identifiers"
      })
    }

    
    const normalizedSeats = seats.map((s) => {
      if (typeof s === "string") return s.trim().toUpperCase()
      if (s && typeof s === "object" && typeof s.seatNumber === "string") {
        return s.seatNumber.trim().toUpperCase()
      }
      return null
    })

    if (normalizedSeats.some((s) => !s)) {
      return res.status(400).json({
        success: false,
        message: "Each seat must be a valid seat string (e.g. 'A1')"
      })
    }

    
    const uniqueSeats = new Set(normalizedSeats)
    if (uniqueSeats.size !== normalizedSeats.length) {
      return res.status(400).json({
        success: false,
        message: "Duplicate seats provided in booking request"
      })
    }

    const requestedSeats = Array.from(uniqueSeats)

    
    await releaseExpiredBookings(showtimeId)

    
    const showtime = await Showtime.findById(showtimeId)
      .populate("movie")
      .populate("screen")

    if (!showtime) {
      return res.status(404).json({ success: false, message: "Showtime not found" })
    }

    if (showtime.status !== "scheduled") {
      return res.status(400).json({
        success: false,
        message: `Cannot book showtime with status '${showtime.status}'`
      })
    }

    
    const showDateObj = new Date(showtime.showDate)
    const [startHour, startMin] = (showtime.startTime || "00:00").split(":").map(Number)
    showDateObj.setHours(startHour, startMin, 0, 0)
    if (showDateObj < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Cannot book tickets for a showtime that has already started or passed"
      })
    }

    const screen = showtime.screen
    if (!screen) {
      return res.status(404).json({ success: false, message: "Screen not found for this showtime" })
    }
    if (screen.status !== "active") {
      return res.status(400).json({ success: false, message: "Screen is currently inactive" })
    }

    const movie = showtime.movie
    if (!movie) {
      return res.status(404).json({ success: false, message: "Movie not found for this showtime" })
    }
    if (movie.status === "ended") {
      return res.status(400).json({ success: false, message: "Cannot book tickets for an ended movie" })
    }

    
    for (const seat of requestedSeats) {
      if (!isValidSeatLabel(seat, screen.totalRows, screen.seatsPerRow)) {
        return res.status(400).json({
          success: false,
          message: `Seat '${seat}' is invalid for screen '${screen.name}' (${screen.totalRows} rows, ${screen.seatsPerRow} seats per row)`
        })
      }
    }

    
    const ticketType = screen.screenType || "standard"
    const unitPrice =
      ticketType === "vip" && showtime.vipPrice != null
        ? showtime.vipPrice
        : showtime.standardPrice

    if (typeof unitPrice !== "number" || unitPrice < 0) {
      return res.status(500).json({
        success: false,
        message: "Price is not properly configured for this showtime"
      })
    }

    const totalAmount = unitPrice * requestedSeats.length
    const bookedSeatsObjects = requestedSeats.map((seatNumber) => ({
      seatNumber,
      ticketType,
      price: unitPrice
    }))

    
    
    const updatedShowtime = await Showtime.findOneAndUpdate(
      {
        _id: showtimeId,
        bookedSeats: { $nin: requestedSeats }
      },
      {
        $addToSet: { bookedSeats: { $each: requestedSeats } }
      },
      { new: true }
    )

    if (!updatedShowtime) {
      return res.status(409).json({
        success: false,
        message: "One or more selected seats are no longer available. Please select different seats."
      })
    }

    
    reservedSeats = requestedSeats
    targetShowtimeId = showtimeId

    
    const holdMinutes = parseInt(process.env.BOOKING_HOLD_MINUTES, 10) || 10
    const expiresAt = new Date(Date.now() + holdMinutes * 60 * 1000)
    const bookingReference = generateBookingReference()

    
    const booking = new Booking({
      user: req.user._id,
      showtime: showtimeId,
      movie: movie._id,
      screen: screen._id,
      seats: bookedSeatsObjects,
      bookingReference,
      totalAmount,
      bookingStatus: "pending-payment",
      paymentStatus: "unpaid",
      expiresAt
    })

    await booking.save()

    
    await booking.populate([
      { path: "movie", select: "title posterUrl runtime rating" },
      { path: "screen", select: "name screenType totalSeats" },
      { path: "showtime", select: "showDate startTime endTime standardPrice vipPrice" },
      { path: "user", select: "name email" }
    ])

    try {
      const emailResult = await sendReservationEmail(booking)
      if (emailResult.success) {
        booking.reservationEmailSentAt = new Date()
        await booking.save()
      } else {
        console.warn("Reservation email could not be sent", { bookingReference: booking.bookingReference })
      }
    } catch (emailErr) {
      console.error("Reservation email tracking failed", {
        error: emailErr.message,
        bookingReference: booking.bookingReference
      })
    }

    return res.status(201).json({
      success: true,
      message: `Seats reserved successfully. Please complete payment within ${holdMinutes} minutes.`,
      booking: {
        id: booking._id,
        bookingReference: booking.bookingReference,
        movie: booking.movie,
        screen: booking.screen,
        showtime: booking.showtime,
        seats: booking.seats,
        totalAmount: booking.totalAmount,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        expiresAt: booking.expiresAt,
        createdAt: booking.createdAt
      }
    })
  } catch (err) {
    console.error("createBooking error:", err)

    
    if (targetShowtimeId && reservedSeats.length > 0) {
      try {
        await Showtime.updateOne(
          { _id: targetShowtimeId },
          { $pull: { bookedSeats: { $in: reservedSeats } } }
        )
      } catch (rollbackErr) {
        console.error("Rollback error after createBooking failure:", rollbackErr)
      }
    }

    return res.status(500).json({ success: false, message: "Server error while creating booking" })
  }
}






const getMyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user._id })
      .populate("movie", "title posterUrl runtime")
      .populate("screen", "name screenType totalSeats")
      .populate("showtime", "showDate startTime endTime standardPrice vipPrice status")
      .sort({ createdAt: -1 })

    return res.status(200).json({
      success: true,
      count: bookings.length,
      bookings
    })
  } catch (err) {
    console.error("getMyBookings error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching user bookings" })
  }
}






const getBookingById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format" })
    }

    const booking = await Booking.findById(req.params.id)
      .populate("user", "name email role")
      .populate("movie", "title posterUrl runtime rating overview")
      .populate("screen", "name screenType totalSeats totalRows seatsPerRow")
      .populate("showtime", "showDate startTime endTime standardPrice vipPrice status")

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" })
    }

    
    const isOwner = booking.user && booking.user._id.toString() === req.user._id.toString()
    const isAdmin = req.user.role === "admin"

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to view this booking"
      })
    }

    return res.status(200).json({
      success: true,
      booking
    })
  } catch (err) {
    console.error("getBookingById error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching booking" })
  }
}






const cancelBooking = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format" })
    }

    const booking = await Booking.findById(req.params.id)
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" })
    }

    
    const isOwner =
      booking.user &&
      (booking.user._id ? booking.user._id.toString() : booking.user.toString()) ===
        req.user._id.toString()
    const isAdmin = req.user.role === "admin"

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to cancel this booking"
      })
    }

    
    if (booking.bookingStatus === "confirmed" || booking.paymentStatus === "paid") {
      return res.status(409).json({
        success: false,
        message: "Paid bookings require the refund workflow"
      })
    }

    
    if (booking.bookingStatus !== "pending-payment") {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel a booking with status '${booking.bookingStatus}'. Only pending-payment bookings can be cancelled.`
      })
    }

    
    booking.bookingStatus = "cancelled"
    await booking.save()

    
    const seatNumbers = booking.seats.map((s) => s.seatNumber)
    if (seatNumbers.length > 0) {
      await Showtime.updateOne(
        { _id: booking.showtime },
        { $pull: { bookedSeats: { $in: seatNumbers } } }
      )
    }

    try {
      await booking.populate([
        { path: "movie", select: "title" },
        { path: "screen", select: "name" },
        { path: "showtime", select: "showDate startTime" },
        { path: "user", select: "name email" }
      ])
      const emailResult = await sendCancellationEmail(booking)
      if (emailResult.success) {
        booking.cancellationEmailSentAt = new Date()
        await booking.save()
      } else {
        console.warn("Booking cancellation email could not be sent", { bookingReference: booking.bookingReference })
      }
    } catch (emailErr) {
      console.error("Booking cancellation email tracking failed", {
        error: emailErr.message,
        bookingReference: booking.bookingReference
      })
    }

    return res.status(200).json({
      success: true,
      message: "Booking cancelled successfully and seats have been released",
      booking: {
        id: booking._id,
        bookingReference: booking.bookingReference,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        releasedSeats: seatNumbers
      }
    })
  } catch (err) {
    console.error("cancelBooking error:", err)
    return res.status(500).json({ success: false, message: "Server error while cancelling booking" })
  }
}






const getAllBookings = async (req, res) => {
  try {
    const filter = {}

    
    if (req.query.bookingStatus) {
      if (!VALID_BOOKING_STATUSES.includes(req.query.bookingStatus)) {
        return res.status(400).json({
          success: false,
          message: `Invalid bookingStatus filter. Must be one of: ${VALID_BOOKING_STATUSES.join(", ")}`
        })
      }
      filter.bookingStatus = req.query.bookingStatus
    }

    
    if (req.query.paymentStatus) {
      if (!VALID_PAYMENT_STATUSES.includes(req.query.paymentStatus)) {
        return res.status(400).json({
          success: false,
          message: `Invalid paymentStatus filter. Must be one of: ${VALID_PAYMENT_STATUSES.join(", ")}`
        })
      }
      filter.paymentStatus = req.query.paymentStatus
    }

    
    if (req.query.movieId) {
      if (!mongoose.isValidObjectId(req.query.movieId)) {
        return res.status(400).json({ success: false, message: "Invalid movieId filter" })
      }
      filter.movie = req.query.movieId
    }

    
    if (req.query.showtimeId) {
      if (!mongoose.isValidObjectId(req.query.showtimeId)) {
        return res.status(400).json({ success: false, message: "Invalid showtimeId filter" })
      }
      filter.showtime = req.query.showtimeId
    }

    
    if (req.query.userId) {
      if (!mongoose.isValidObjectId(req.query.userId)) {
        return res.status(400).json({ success: false, message: "Invalid userId filter" })
      }
      filter.user = req.query.userId
    }

    
    if (req.query.search && String(req.query.search).trim()) {
      const searchRegex = new RegExp(String(req.query.search).trim(), "i")
      const matchingUsers = await User.find({
        $or: [{ name: searchRegex }, { email: searchRegex }]
      }).select("_id")

      const userIds = matchingUsers.map((u) => u._id)

      filter.$or = [
        { bookingReference: searchRegex },
        { paymentReference: searchRegex },
        { user: { $in: userIds } }
      ]
    }

    
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const skip = (page - 1) * limit

    const total = await Booking.countDocuments(filter)
    const pages = Math.ceil(total / limit) || 1

    const bookings = await Booking.find(filter)
      .populate("user", "name email")
      .populate("movie", "title posterUrl runtime rating")
      .populate("screen", "name screenType totalSeats")
      .populate("showtime", "showDate startTime standardPrice vipPrice")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)

    return res.status(200).json({
      success: true,
      count: bookings.length,
      pagination: {
        page,
        limit,
        total,
        pages
      },
      bookings
    })
  } catch (err) {
    console.error("getAllBookings error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching all bookings" })
  }
}

module.exports = {
  createBooking,
  getMyBookings,
  getBookingById,
  cancelBooking,
  getAllBookings
}