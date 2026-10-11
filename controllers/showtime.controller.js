const mongoose = require("mongoose")
const Showtime = require("../models/Showtime.model")
const Movie = require("../models/Movie.model")
const Screen = require("../models/Screen.model")
const Booking = require("../models/Booking.model")
const { releaseExpiredBookings, generateSeatLayout } = require("../utils/booking.util")
const { sendShowtimeCancellationEmail } = require("../services/email.service")



const VALID_STATUSES = ["scheduled", "cancelled", "completed"]
const MOVIE_STATUSES_ALLOWED = ["coming-soon", "now-showing"] 


const isValidTime = (str) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(str)


const timeToMinutes = (str) => {
  const [h, m] = str.split(":").map(Number)
  return h * 60 + m
}


const addMinutesToTime = (str, minutes) => {
  const total = timeToMinutes(str) + minutes
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}


const toMidnight = (date) => {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}


const todayMidnight = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}




const hasSchedulingConflict = async (screenId, showDate, startTime, runtimeMinutes, excludeId) => {
  const dayStart = toMidnight(showDate)
  const dayEnd = new Date(dayStart)
  dayEnd.setDate(dayEnd.getDate() + 1)

  const query = {
    screen: screenId,
    showDate: { $gte: dayStart, $lt: dayEnd },
    status: "scheduled"
  }

  if (excludeId) query._id = { $ne: excludeId }

  const existingShowtimes = await Showtime.find(query)

  if (existingShowtimes.length === 0) return false

  const proposedStart = timeToMinutes(startTime)
  
  const proposedEnd = runtimeMinutes ? proposedStart + runtimeMinutes : proposedStart

  for (const st of existingShowtimes) {
    const existingStart = timeToMinutes(st.startTime)

    if (runtimeMinutes && st.endTime) {
      
      const existingEnd = timeToMinutes(st.endTime)
      
      if (proposedStart < existingEnd && proposedEnd > existingStart) {
        return true
      }
    } else {
      
      if (proposedStart === existingStart) return true
    }
  }

  return false
}






const createShowtime = async (req, res) => {
  try {
    const { movieId, screenId, showDate, startTime, standardPrice, vipPrice } = req.body

    
    if (!movieId) return res.status(400).json({ success: false, message: "movieId is required" })
    if (!screenId) return res.status(400).json({ success: false, message: "screenId is required" })
    if (!showDate) return res.status(400).json({ success: false, message: "showDate is required" })
    if (!startTime) return res.status(400).json({ success: false, message: "startTime is required" })
    if (standardPrice === undefined || standardPrice === null || standardPrice === "") {
      return res.status(400).json({ success: false, message: "standardPrice is required" })
    }

    
    if (!mongoose.isValidObjectId(movieId)) {
      return res.status(400).json({ success: false, message: "Invalid movieId format" })
    }
    if (!mongoose.isValidObjectId(screenId)) {
      return res.status(400).json({ success: false, message: "Invalid screenId format" })
    }

    
    const parsedDate = new Date(showDate)
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid showDate — use YYYY-MM-DD format" })
    }

    
    const showDay = toMidnight(parsedDate)
    if (showDay < todayMidnight()) {
      return res.status(400).json({ success: false, message: "Show date cannot be in the past" })
    }

    
    if (!isValidTime(startTime)) {
      return res.status(400).json({ success: false, message: "Invalid startTime — use HH:MM format (24-hour)" })
    }

    
    const stdPrice = Number(standardPrice)
    if (isNaN(stdPrice) || stdPrice < 0) {
      return res.status(400).json({ success: false, message: "standardPrice must be a non-negative number" })
    }

    let vipPriceVal = null
    if (vipPrice !== undefined && vipPrice !== null && vipPrice !== "") {
      vipPriceVal = Number(vipPrice)
      if (isNaN(vipPriceVal) || vipPriceVal < 0) {
        return res.status(400).json({ success: false, message: "vipPrice must be a non-negative number" })
      }
    }

    
    const movie = await Movie.findById(movieId)
    if (!movie) {
      return res.status(404).json({ success: false, message: "Movie not found" })
    }
    if (movie.status === "ended") {
      return res.status(400).json({ success: false, message: "Cannot create a showtime for a movie marked as ended" })
    }

    
    const screen = await Screen.findById(screenId)
    if (!screen) {
      return res.status(404).json({ success: false, message: "Screen not found" })
    }
    if (screen.status !== "active") {
      return res.status(400).json({ success: false, message: "The selected screen is not active" })
    }

    
    
    const runtimeMinutes = movie.runtime || null
    const conflict = await hasSchedulingConflict(screenId, parsedDate, startTime, runtimeMinutes, null)
    if (conflict) {
      return res.status(409).json({
        success: false,
        message: "This screen already has a showtime at the selected time"
      })
    }

    
    let endTime = null
    if (runtimeMinutes) {
      endTime = addMinutesToTime(startTime, runtimeMinutes)
    }

    
    const showtime = new Showtime({
      movie: movieId,
      screen: screenId,
      showDate: parsedDate,
      startTime,
      endTime,
      standardPrice: stdPrice,
      vipPrice: vipPriceVal,
      status: "scheduled",
      createdBy: req.user._id
    })

    await showtime.save()

    
    await showtime.populate([
      { path: "movie", select: "title posterUrl runtime status" },
      { path: "screen", select: "name screenType totalSeats" }
    ])

    return res.status(201).json({
      success: true,
      message: "Showtime created successfully",
      showtime
    })
  } catch (err) {
    console.error("createShowtime error:", err)
    return res.status(500).json({ success: false, message: "Server error while creating showtime" })
  }
}






const getAllShowtimes = async (req, res) => {
  try {
    const filter = {}

    
    if (req.query.movieId) {
      if (!mongoose.isValidObjectId(req.query.movieId)) {
        return res.status(400).json({ success: false, message: "Invalid movieId filter" })
      }
      filter.movie = req.query.movieId
    }

    
    if (req.query.screenId) {
      if (!mongoose.isValidObjectId(req.query.screenId)) {
        return res.status(400).json({ success: false, message: "Invalid screenId filter" })
      }
      filter.screen = req.query.screenId
    }

    
    if (req.query.date) {
      const d = new Date(req.query.date)
      if (isNaN(d.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid date filter — use YYYY-MM-DD" })
      }
      const dayStart = toMidnight(d)
      const dayEnd = new Date(dayStart)
      dayEnd.setDate(dayEnd.getDate() + 1)
      filter.showDate = { $gte: dayStart, $lt: dayEnd }
    }

    
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(", ")}`
        })
      }
      filter.status = req.query.status
    }

    const showtimes = await Showtime.find(filter)
      .populate("movie", "id title posterUrl runtime")
      .populate("screen", "id name screenType totalSeats")
      .sort({ showDate: 1, startTime: 1 })

    return res.status(200).json({
      success: true,
      count: showtimes.length,
      showtimes
    })
  } catch (err) {
    console.error("getAllShowtimes error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching showtimes" })
  }
}






const getShowtimesForMovie = async (req, res) => {
  try {
    const { movieId } = req.params

    if (!mongoose.isValidObjectId(movieId)) {
      return res.status(400).json({ success: false, message: "Invalid movieId format" })
    }

    
    const movie = await Movie.findById(movieId)
    if (!movie) {
      return res.status(404).json({ success: false, message: "Movie not found" })
    }

    
    const now = todayMidnight()
    const showtimes = await Showtime.find({
      movie: movieId,
      status: "scheduled",
      showDate: { $gte: now }
    })
      .populate("screen", "id name screenType totalSeats")
      .sort({ showDate: 1, startTime: 1 })

    
    const formatted = showtimes.map((st) => ({
      id: st._id,
      date: st.showDate.toISOString().split("T")[0],
      startTime: st.startTime,
      endTime: st.endTime || null,
      screen: {
        name: st.screen?.name,
        screenType: st.screen?.screenType,
        totalSeats: st.screen?.totalSeats
      },
      pricing: {
        standard: st.standardPrice,
        vip: st.vipPrice
      },
      status: st.status
    }))

    return res.status(200).json({
      success: true,
      movie: {
        id: movie._id,
        title: movie.title,
        posterUrl: movie.posterUrl
      },
      count: formatted.length,
      showtimes: formatted
    })
  } catch (err) {
    console.error("getShowtimesForMovie error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching showtimes" })
  }
}






const getShowtimeById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid showtime ID format" })
    }

    const showtime = await Showtime.findById(req.params.id)
      .populate("movie", "title overview posterUrl backdropUrl runtime rating genres language status")
      .populate("screen", "name screenType totalRows seatsPerRow totalSeats status")

    if (!showtime) {
      return res.status(404).json({ success: false, message: "Showtime not found" })
    }

    return res.status(200).json({ success: true, showtime })
  } catch (err) {
    console.error("getShowtimeById error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching showtime" })
  }
}






const updateShowtime = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid showtime ID format" })
    }

    const showtime = await Showtime.findById(req.params.id)
    if (!showtime) {
      return res.status(404).json({ success: false, message: "Showtime not found" })
    }
    const originalShowtime = {
      showDate: showtime.showDate,
      startTime: showtime.startTime
    }

    const { movieId, screenId, showDate, startTime, standardPrice, vipPrice, status } = req.body
    const shouldNotifyCancellation = showtime.status === "scheduled" && status === "cancelled"

    
    if (
      movieId === undefined &&
      screenId === undefined &&
      showDate === undefined &&
      startTime === undefined &&
      standardPrice === undefined &&
      vipPrice === undefined &&
      status === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one field to update"
      })
    }

    
    let newMovieId = showtime.movie.toString()
    let newScreenId = showtime.screen.toString()
    let newShowDate = showtime.showDate
    let newStartTime = showtime.startTime
    let runtimeMinutes = null
    let recalculateConflict = false

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`
        })
      }
      showtime.status = status
    }

    if (movieId !== undefined) {
      if (!mongoose.isValidObjectId(movieId)) {
        return res.status(400).json({ success: false, message: "Invalid movieId format" })
      }
      const movie = await Movie.findById(movieId)
      if (!movie) return res.status(404).json({ success: false, message: "Movie not found" })
      if (movie.status === "ended") {
        return res.status(400).json({ success: false, message: "Cannot assign an ended movie to a showtime" })
      }
      newMovieId = movieId
      runtimeMinutes = movie.runtime || null
      showtime.movie = movieId
      recalculateConflict = true
    }

    if (screenId !== undefined) {
      if (!mongoose.isValidObjectId(screenId)) {
        return res.status(400).json({ success: false, message: "Invalid screenId format" })
      }
      const screen = await Screen.findById(screenId)
      if (!screen) return res.status(404).json({ success: false, message: "Screen not found" })
      if (screen.status !== "active") {
        return res.status(400).json({ success: false, message: "The selected screen is not active" })
      }
      newScreenId = screenId
      showtime.screen = screenId
      recalculateConflict = true
    }

    if (showDate !== undefined) {
      const parsed = new Date(showDate)
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid showDate — use YYYY-MM-DD format" })
      }
      const showDay = toMidnight(parsed)
      if (showDay < todayMidnight()) {
        return res.status(400).json({ success: false, message: "Show date cannot be in the past" })
      }
      newShowDate = parsed
      showtime.showDate = parsed
      recalculateConflict = true
    }

    if (startTime !== undefined) {
      if (!isValidTime(startTime)) {
        return res.status(400).json({ success: false, message: "Invalid startTime — use HH:MM format (24-hour)" })
      }
      newStartTime = startTime
      showtime.startTime = startTime
      recalculateConflict = true
    }

    if (standardPrice !== undefined) {
      const p = Number(standardPrice)
      if (isNaN(p) || p < 0) {
        return res.status(400).json({ success: false, message: "standardPrice must be a non-negative number" })
      }
      showtime.standardPrice = p
    }

    if (vipPrice !== undefined) {
      if (vipPrice === null || vipPrice === "") {
        showtime.vipPrice = null
      } else {
        const p = Number(vipPrice)
        if (isNaN(p) || p < 0) {
          return res.status(400).json({ success: false, message: "vipPrice must be a non-negative number" })
        }
        showtime.vipPrice = p
      }
    }

    
    if (recalculateConflict) {
      
      if (movieId === undefined) {
        const currentMovie = await Movie.findById(newMovieId)
        runtimeMinutes = currentMovie?.runtime || null
      }

      const conflict = await hasSchedulingConflict(
        newScreenId,
        newShowDate,
        newStartTime,
        runtimeMinutes,
        req.params.id 
      )
      if (conflict) {
        return res.status(409).json({
          success: false,
          message: "This screen already has a showtime at the selected time"
        })
      }

      
      showtime.endTime = runtimeMinutes ? addMinutesToTime(newStartTime, runtimeMinutes) : null
    }

    await showtime.save()

    await showtime.populate([
      { path: "movie", select: "title posterUrl runtime status" },
      { path: "screen", select: "name screenType totalSeats" }
    ])

    if (shouldNotifyCancellation) {
      try {
        const affectedBookings = await Booking.find({
          showtime: showtime._id,
          bookingStatus: { $in: ["confirmed", "pending-payment"] },
          showtimeCancellationEmailSentAt: { $exists: false }
        })
          .populate("user", "name email")
          .populate("movie", "title")
          .populate("screen", "name")
          .populate("showtime", "showDate startTime")

        for (const booking of affectedBookings) {
          try {
            const emailResult = await sendShowtimeCancellationEmail(booking, originalShowtime)
            if (emailResult.success) {
              await Booking.updateOne(
                { _id: booking._id, showtimeCancellationEmailSentAt: { $exists: false } },
                { $set: { showtimeCancellationEmailSentAt: new Date() } }
              )
            } else {
              console.warn("Showtime cancellation email could not be sent", {
                bookingReference: booking.bookingReference
              })
            }
          } catch (emailErr) {
            console.error("Showtime cancellation notification failed", {
              error: emailErr.message,
              bookingReference: booking.bookingReference
            })
          }
        }
      } catch (notificationErr) {
        console.error("Could not load bookings for showtime cancellation notifications", {
          error: notificationErr.message,
          showtimeId: showtime._id
        })
      }
    }

    return res.status(200).json({
      success: true,
      message: "Showtime updated successfully",
      showtime
    })
  } catch (err) {
    console.error("updateShowtime error:", err)
    return res.status(500).json({ success: false, message: "Server error while updating showtime" })
  }
}






const getShowtimeSeats = async (req, res) => {
  try {
    const { showtimeId } = req.params

    if (!mongoose.isValidObjectId(showtimeId)) {
      return res.status(400).json({ success: false, message: "Invalid showtime ID format" })
    }

    
    await releaseExpiredBookings(showtimeId)

    const showtime = await Showtime.findById(showtimeId)
      .populate("movie", "title posterUrl runtime status")
      .populate("screen", "name screenType totalRows seatsPerRow totalSeats status")

    if (!showtime) {
      return res.status(404).json({ success: false, message: "Showtime not found" })
    }

    if (!showtime.screen) {
      return res.status(404).json({ success: false, message: "Screen configuration not found for this showtime" })
    }

    const { rows, summary } = generateSeatLayout(showtime.screen, showtime)

    return res.status(200).json({
      success: true,
      showtime: {
        id: showtime._id,
        movie: {
          id: showtime.movie?._id,
          title: showtime.movie?.title,
          posterUrl: showtime.movie?.posterUrl
        },
        screen: {
          id: showtime.screen._id,
          name: showtime.screen.name,
          screenType: showtime.screen.screenType,
          totalSeats: showtime.screen.totalSeats,
          totalRows: showtime.screen.totalRows,
          seatsPerRow: showtime.screen.seatsPerRow
        },
        pricing: {
          standard: showtime.standardPrice,
          vip: showtime.vipPrice
        },
        availability: summary,
        layout: rows
      }
    })
  } catch (err) {
    console.error("getShowtimeSeats error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching showtime seats" })
  }
}






const deleteShowtime = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid showtime ID format" })
    }

    
    const activeBookings = await Booking.countDocuments({
      showtime: req.params.id,
      bookingStatus: { $in: ["pending-payment", "confirmed"] }
    })

    if (activeBookings > 0) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete showtime with active bookings. Cancel the showtime or bookings first."
      })
    }

    const showtime = await Showtime.findByIdAndDelete(req.params.id)
    if (!showtime) {
      return res.status(404).json({ success: false, message: "Showtime not found" })
    }

    return res.status(200).json({
      success: true,
      message: "Showtime deleted successfully"
    })
  } catch (err) {
    console.error("deleteShowtime error:", err)
    return res.status(500).json({ success: false, message: "Server error while deleting showtime" })
  }
}

module.exports = {
  createShowtime,
  getAllShowtimes,
  getShowtimesForMovie,
  getShowtimeById,
  getShowtimeSeats,
  updateShowtime,
  deleteShowtime
}