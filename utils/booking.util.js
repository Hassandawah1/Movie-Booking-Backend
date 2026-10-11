const crypto = require("crypto")
const Booking = require("../models/Booking.model")
const Showtime = require("../models/Showtime.model")

/**
 * Generate a unique booking reference
 * Format: MB-<timestamp>-<hex> (e.g. MB-1712419200000-A1B2C3)
 */
const generateBookingReference = () => {
  return `MB-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`
}

/**
 * Validate seat label against screen dimensions
 * Rows: A-Z (1 to totalRows)
 * Columns: 1 to seatsPerRow
 */
const isValidSeatLabel = (seatStr, totalRows, seatsPerRow) => {
  if (typeof seatStr !== "string") return false
  const match = seatStr.trim().toUpperCase().match(/^([A-Z])([1-9]\d*)$/)
  if (!match) return false

  const rowLetter = match[1]
  const colNumber = parseInt(match[2], 10)

  const rowIndex = rowLetter.charCodeAt(0) - 65 + 1 // A -> 1, B -> 2, etc.

  if (rowIndex < 1 || rowIndex > totalRows) return false
  if (colNumber < 1 || colNumber > seatsPerRow) return false

  return true
}

/**
 * Lazy cleanup: Releases expired pending-payment bookings for a specific showtime
 * and pulls their seats from Showtime.bookedSeats
 */
const releaseExpiredBookings = async (showtimeId) => {
  try {
    const now = new Date()
    const expiredBookings = await Booking.find({
      showtime: showtimeId,
      bookingStatus: "pending-payment",
      expiresAt: { $lt: now }
    })

    if (!expiredBookings || expiredBookings.length === 0) {
      return
    }

    const expiredSeats = []
    const bookingIds = []

    for (const b of expiredBookings) {
      bookingIds.push(b._id)
      if (Array.isArray(b.seats)) {
        for (const s of b.seats) {
          if (s.seatNumber) expiredSeats.push(s.seatNumber)
        }
      }
    }

    // Mark bookings as expired
    await Booking.updateMany(
      { _id: { $in: bookingIds } },
      { $set: { bookingStatus: "expired" } }
    )

    // Remove released seats from Showtime.bookedSeats
    if (expiredSeats.length > 0) {
      await Showtime.updateOne(
        { _id: showtimeId },
        { $pull: { bookedSeats: { $in: expiredSeats } } }
      )
    }
  } catch (err) {
    console.error("releaseExpiredBookings error:", err)
  }
}

/**
 * Generate full seat layout grid with availability status
 */
const generateSeatLayout = (screen, showtime) => {
  const bookedSet = new Set(showtime.bookedSeats || [])
  const rows = []
  let availableCount = 0
  let bookedCount = 0

  const seatPrice =
    screen.screenType === "vip" && showtime.vipPrice != null
      ? showtime.vipPrice
      : showtime.standardPrice

  for (let r = 0; r < screen.totalRows; r++) {
    const rowLetter = String.fromCharCode(65 + r)
    const rowSeats = []

    for (let s = 1; s <= screen.seatsPerRow; s++) {
      const seatNumber = `${rowLetter}${s}`
      const isBooked = bookedSet.has(seatNumber)

      if (isBooked) {
        bookedCount++
      } else {
        availableCount++
      }

      rowSeats.push({
        seatNumber,
        row: rowLetter,
        column: s,
        status: isBooked ? "unavailable" : "available",
        ticketType: screen.screenType,
        price: seatPrice
      })
    }

    rows.push({
      row: rowLetter,
      seats: rowSeats
    })
  }

  return {
    rows,
    summary: {
      totalSeats: screen.totalSeats || screen.totalRows * screen.seatsPerRow,
      availableSeats: availableCount,
      bookedSeats: bookedCount
    }
  }
}

module.exports = {
  generateBookingReference,
  isValidSeatLabel,
  releaseExpiredBookings,
  generateSeatLayout
}
