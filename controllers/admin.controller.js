const mongoose = require("mongoose")
const User = require("../models/User.model")
const Movie = require("../models/Movie.model")
const Screen = require("../models/Screen.model")
const Showtime = require("../models/Showtime.model")
const Booking = require("../models/Booking.model")
const { sendRoleChangedEmail } = require("../services/email.service")



const todayMidnight = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

const todayEndOfDay = () => {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d
}




const toLocalDateString = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}





const getDashboardSummary = async (req, res) => {
  try {
    const todayStart = todayMidnight()
    const todayEnd = todayEndOfDay()

    
    const [
      totalUsers,
      totalMovies,
      nowShowingMovies,
      comingSoonMovies,
      endedMovies,
      totalShowtimes,
      upcomingShowtimes,
      totalBookings,
      confirmedBookings,
      pendingPaymentBookings,
      cancelledBookings,
      expiredBookings,
      paidPayments,
      unpaidPayments,
      failedPayments,
      refundedPayments,
      totalRevenueResult,
      todayRevenueResult
    ] = await Promise.all([
      User.countDocuments(),
      Movie.countDocuments(),
      Movie.countDocuments({ status: "now-showing" }),
      Movie.countDocuments({ status: "coming-soon" }),
      Movie.countDocuments({ status: "ended" }),
      Showtime.countDocuments(),
      Showtime.countDocuments({ status: "scheduled", showDate: { $gte: todayStart } }),
      Booking.countDocuments(),
      Booking.countDocuments({ bookingStatus: "confirmed" }),
      Booking.countDocuments({ bookingStatus: "pending-payment" }),
      Booking.countDocuments({ bookingStatus: "cancelled" }),
      Booking.countDocuments({ bookingStatus: "expired" }),
      Booking.countDocuments({ paymentStatus: "paid" }),
      Booking.countDocuments({ paymentStatus: "unpaid" }),
      Booking.countDocuments({ paymentStatus: "failed" }),
      Booking.countDocuments({ paymentStatus: "refunded" }),
      
      Booking.aggregate([
        { $match: { paymentStatus: "paid" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } }
      ]),
      
      Booking.aggregate([
        {
          $match: {
            paymentStatus: "paid",
            $or: [
              { paidAt: { $gte: todayStart, $lte: todayEnd } },
              { paidAt: { $exists: false }, createdAt: { $gte: todayStart, $lte: todayEnd } }
            ]
          }
        },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } }
      ])
    ])

    const totalRevenue = totalRevenueResult[0]?.total || 0
    const todayRevenue = todayRevenueResult[0]?.total || 0

    return res.status(200).json({
      success: true,
      summary: {
        users: {
          total: totalUsers
        },
        movies: {
          total: totalMovies,
          nowShowing: nowShowingMovies,
          comingSoon: comingSoonMovies,
          ended: endedMovies
        },
        showtimes: {
          total: totalShowtimes,
          upcoming: upcomingShowtimes
        },
        bookings: {
          total: totalBookings,
          confirmed: confirmedBookings,
          pendingPayment: pendingPaymentBookings,
          cancelled: cancelledBookings,
          expired: expiredBookings
        },
        payments: {
          paid: paidPayments,
          unpaid: unpaidPayments,
          failed: failedPayments,
          refunded: refundedPayments
        },
        revenue: {
          total: totalRevenue,
          today: todayRevenue
        }
      }
    })
  } catch (err) {
    console.error("getDashboardSummary error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching dashboard summary" })
  }
}






const getRevenueAnalytics = async (req, res) => {
  try {
    let { startDate, endDate } = req.query

    let start
    let end

    if (startDate) {
      start = new Date(startDate)
      if (isNaN(start.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid startDate format (use YYYY-MM-DD)" })
      }
      start.setHours(0, 0, 0, 0)
    } else {
      
      start = new Date()
      start.setDate(1)
      start.setHours(0, 0, 0, 0)
    }

    if (endDate) {
      end = new Date(endDate)
      if (isNaN(end.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid endDate format (use YYYY-MM-DD)" })
      }
      end.setHours(23, 59, 59, 999)
    } else {
      
      end = todayEndOfDay()
    }

    if (start > end) {
      return res.status(400).json({
        success: false,
        message: "startDate cannot be after endDate"
      })
    }

    const result = await Booking.aggregate([
      {
        $match: {
          paymentStatus: "paid",
          $or: [
            { paidAt: { $gte: start, $lte: end } },
            { paidAt: { $exists: false }, createdAt: { $gte: start, $lte: end } }
          ]
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmount" },
          totalPaidBookings: { $sum: 1 }
        }
      }
    ])

    const totalRevenue = result[0]?.totalRevenue || 0
    const totalPaidBookings = result[0]?.totalPaidBookings || 0

    return res.status(200).json({
      success: true,
      analytics: {
        startDate: toLocalDateString(start),
        endDate: toLocalDateString(end),
        totalRevenue,
        totalPaidBookings
      }
    })
  } catch (err) {
    console.error("getRevenueAnalytics error:", err)
    return res.status(500).json({ success: false, message: "Server error while calculating revenue analytics" })
  }
}






const getRevenueTrend = async (req, res) => {
  try {
    const period = req.query.period === "30d" ? "30d" : "7d"
    const days = period === "30d" ? 30 : 7

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - (days - 1))
    startDate.setHours(0, 0, 0, 0)

    const rawDailyData = await Booking.aggregate([
      {
        $match: {
          paymentStatus: "paid",
          $or: [
            { paidAt: { $gte: startDate } },
            { paidAt: { $exists: false }, createdAt: { $gte: startDate } }
          ]
        }
      },
      {
        $project: {
          totalAmount: 1,
          dateKey: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: { $ifNull: ["$paidAt", "$createdAt"] }
            }
          }
        }
      },
      {
        $group: {
          _id: "$dateKey",
          revenue: { $sum: "$totalAmount" },
          bookings: { $sum: 1 }
        }
      }
    ])

    const dataMap = new Map()
    for (const item of rawDailyData) {
      dataMap.set(item._id, { revenue: item.revenue, bookings: item.bookings })
    }

    
    const trendData = []
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate)
      d.setDate(d.getDate() + i)
      
      
      const dateStr = toLocalDateString(d)
      const existing = dataMap.get(dateStr)

      trendData.push({
        date: dateStr,
        revenue: existing ? existing.revenue : 0,
        bookings: existing ? existing.bookings : 0
      })
    }

    return res.status(200).json({
      success: true,
      period,
      data: trendData
    })
  } catch (err) {
    console.error("getRevenueTrend error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching revenue trend" })
  }
}






const getRecentBookings = async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))

    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("user", "name email")
      .populate("movie", "title posterUrl runtime")
      .populate("screen", "name screenType")
      .populate("showtime", "showDate startTime")

    const formatted = bookings.map((b) => ({
      id: b._id,
      bookingReference: b.bookingReference,
      customer: {
        id: b.user?._id,
        name: b.user?.name,
        email: b.user?.email
      },
      movie: {
        id: b.movie?._id,
        title: b.movie?.title,
        posterUrl: b.movie?.posterUrl
      },
      showtime: {
        id: b.showtime?._id,
        showDate: b.showtime?.showDate,
        startTime: b.showtime?.startTime
      },
      screen: {
        id: b.screen?._id,
        name: b.screen?.name,
        screenType: b.screen?.screenType
      },
      seats: b.seats,
      totalAmount: b.totalAmount,
      bookingStatus: b.bookingStatus,
      paymentStatus: b.paymentStatus,
      paymentReference: b.paymentReference || null,
      createdAt: b.createdAt
    }))

    return res.status(200).json({
      success: true,
      count: formatted.length,
      bookings: formatted
    })
  } catch (err) {
    console.error("getRecentBookings error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching recent bookings" })
  }
}






const getUpcomingShowtimes = async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))
    const todayStart = todayMidnight()

    const showtimes = await Showtime.find({
      status: "scheduled",
      showDate: { $gte: todayStart }
    })
      .sort({ showDate: 1, startTime: 1 })
      .limit(limit)
      .populate("movie", "title posterUrl runtime")
      .populate("screen", "name screenType totalSeats")

    const formatted = showtimes.map((st) => {
      const bookedCount = Array.isArray(st.bookedSeats) ? st.bookedSeats.length : 0
      const totalSeats = st.screen?.totalSeats || 0
      const remainingSeats = Math.max(0, totalSeats - bookedCount)

      return {
        id: st._id,
        movie: {
          id: st.movie?._id,
          title: st.movie?.title,
          posterUrl: st.movie?.posterUrl,
          runtime: st.movie?.runtime
        },
        screen: {
          id: st.screen?._id,
          name: st.screen?.name,
          screenType: st.screen?.screenType,
          totalSeats
        },
        showDate: st.showDate,
        startTime: st.startTime,
        endTime: st.endTime || null,
        pricing: {
          standard: st.standardPrice,
          vip: st.vipPrice
        },
        bookedSeatsCount: bookedCount,
        totalSeats,
        remainingSeats
      }
    })

    return res.status(200).json({
      success: true,
      count: formatted.length,
      showtimes: formatted
    })
  } catch (err) {
    console.error("getUpcomingShowtimes error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching upcoming showtimes" })
  }
}






const getTopMovies = async (req, res) => {
  try {
    const sortBy = req.query.sortBy === "bookings" ? "bookings" : "revenue"
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))

    const sortStage = sortBy === "bookings" ? { bookings: -1 } : { revenue: -1 }

    const topMovies = await Booking.aggregate([
      { $match: { paymentStatus: "paid" } },
      {
        $group: {
          _id: "$movie",
          bookings: { $sum: 1 },
          ticketsSold: { $sum: { $size: { $ifNull: ["$seats", []] } } },
          revenue: { $sum: "$totalAmount" }
        }
      },
      {
        $lookup: {
          from: "movies",
          localField: "_id",
          foreignField: "_id",
          as: "movieDetails"
        }
      },
      { $unwind: "$movieDetails" },
      { $sort: sortStage },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          movieId: "$_id",
          title: "$movieDetails.title",
          posterUrl: "$movieDetails.posterUrl",
          bookings: "$bookings",
          ticketsSold: "$ticketsSold",
          revenue: "$revenue"
        }
      }
    ])

    return res.status(200).json({
      success: true,
      sortBy,
      count: topMovies.length,
      movies: topMovies
    })
  } catch (err) {
    console.error("getTopMovies error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching top movies" })
  }
}






const getBookingAnalytics = async (req, res) => {
  try {
    const [total, confirmed, pendingPayment, cancelled, expired] = await Promise.all([
      Booking.countDocuments(),
      Booking.countDocuments({ bookingStatus: "confirmed" }),
      Booking.countDocuments({ bookingStatus: "pending-payment" }),
      Booking.countDocuments({ bookingStatus: "cancelled" }),
      Booking.countDocuments({ bookingStatus: "expired" })
    ])

    return res.status(200).json({
      success: true,
      data: {
        total,
        confirmed,
        pendingPayment,
        cancelled,
        expired
      }
    })
  } catch (err) {
    console.error("getBookingAnalytics error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching booking analytics" })
  }
}






const getPaymentAnalytics = async (req, res) => {
  try {
    const [paid, unpaid, failed, refunded] = await Promise.all([
      Booking.countDocuments({ paymentStatus: "paid" }),
      Booking.countDocuments({ paymentStatus: "unpaid" }),
      Booking.countDocuments({ paymentStatus: "failed" }),
      Booking.countDocuments({ paymentStatus: "refunded" })
    ])

    return res.status(200).json({
      success: true,
      data: {
        paid,
        unpaid,
        failed,
        refunded
      }
    })
  } catch (err) {
    console.error("getPaymentAnalytics error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching payment analytics" })
  }
}






const getAllUsers = async (req, res) => {
  try {
    const filter = {}

    
    if (req.query.role) {
      if (!["user", "admin"].includes(req.query.role)) {
        return res.status(400).json({ success: false, message: "Invalid role filter. Must be 'user' or 'admin'" })
      }
      filter.role = req.query.role
    }

    
    if (req.query.search && String(req.query.search).trim()) {
      const searchRegex = new RegExp(String(req.query.search).trim(), "i")
      filter.$or = [{ name: searchRegex }, { email: searchRegex }]
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const skip = (page - 1) * limit

    const total = await User.countDocuments(filter)
    const pages = Math.ceil(total / limit) || 1

    const users = await User.find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)

    return res.status(200).json({
      success: true,
      count: users.length,
      pagination: {
        page,
        limit,
        total,
        pages
      },
      users
    })
  } catch (err) {
    console.error("getAllUsers error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching users" })
  }
}






const getUserById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID format" })
    }

    const user = await User.findById(req.params.id).select("-password")
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    
    const [bookingCount, confirmedBookingCount, spendingResult] = await Promise.all([
      Booking.countDocuments({ user: user._id }),
      Booking.countDocuments({ user: user._id, bookingStatus: "confirmed" }),
      Booking.aggregate([
        { $match: { user: user._id, paymentStatus: "paid" } },
        { $group: { _id: null, totalSpent: { $sum: "$totalAmount" } } }
      ])
    ])

    const totalSpent = spendingResult[0]?.totalSpent || 0

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        bookingCount,
        confirmedBookingCount,
        totalSpent
      }
    })
  } catch (err) {
    console.error("getUserById error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching user details" })
  }
}






const updateUserRole = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid user ID format" })
    }

    const { role } = req.body
    if (!role || !["user", "admin"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid role. Role must be 'user' or 'admin'"
      })
    }

    
    if (req.user._id.toString() === req.params.id && role === "user") {
      return res.status(400).json({
        success: false,
        message: "You cannot remove your own admin access"
      })
    }

    const user = await User.findById(req.params.id)
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" })
    }

    // Check if trying to modify the main admin's role
    if (user.email === process.env.ADMIN_EMAIL) {
      // Only allow the main admin themselves to modify their role
      if (req.user.email !== process.env.ADMIN_EMAIL) {
        return res.status(403).json({
          success: false,
          message: "Only the main administrator can modify the main administrator's role"
        });
      }
    }

    const previousRole = user.role
    if (previousRole !== role) {
      user.role = role
      await user.save()
      try {
        const emailResult = await sendRoleChangedEmail(user, role)
        if (!emailResult.success) {
          console.warn("Role-change email could not be sent", { userId: user._id })
        }
      } catch (emailErr) {
        console.error("Role-change email failed after role update", {
          error: emailErr.message,
          userId: user._id
        })
      }
    }

    return res.status(200).json({
      success: true,
      message: `User role successfully updated to '${role}'`,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        updatedAt: user.updatedAt
      }
    })
  } catch (err) {
    console.error("updateUserRole error:", err)
    return res.status(500).json({ success: false, message: "Server error while updating user role" })
  }
}






const getShowtimeOccupancy = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid showtime ID format" })
    }

    const showtime = await Showtime.findById(req.params.id).populate("screen")
    if (!showtime) {
      return res.status(404).json({ success: false, message: "Showtime not found" })
    }

    const totalSeats = showtime.screen?.totalSeats || 0
    const bookedSeats = Array.isArray(showtime.bookedSeats) ? showtime.bookedSeats.length : 0
    const availableSeats = Math.max(0, totalSeats - bookedSeats)
    const occupancyPercentage = totalSeats > 0 ? Math.round((bookedSeats / totalSeats) * 100) : 0

    return res.status(200).json({
      success: true,
      occupancy: {
        showtimeId: showtime._id,
        screenName: showtime.screen?.name,
        totalSeats,
        bookedSeats,
        availableSeats,
        occupancyPercentage
      }
    })
  } catch (err) {
    console.error("getShowtimeOccupancy error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching showtime occupancy" })
  }
}






const getShowtimeRevenue = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid showtime ID format" })
    }

    const showtime = await Showtime.findById(req.params.id)
    if (!showtime) {
      return res.status(404).json({ success: false, message: "Showtime not found" })
    }

    const result = await Booking.aggregate([
      {
        $match: {
          showtime: new mongoose.Types.ObjectId(req.params.id),
          paymentStatus: "paid"
        }
      },
      {
        $group: {
          _id: null,
          paidBookings: { $sum: 1 },
          ticketsSold: { $sum: { $size: { $ifNull: ["$seats", []] } } },
          revenue: { $sum: "$totalAmount" }
        }
      }
    ])

    const paidBookings = result[0]?.paidBookings || 0
    const ticketsSold = result[0]?.ticketsSold || 0
    const revenue = result[0]?.revenue || 0

    return res.status(200).json({
      success: true,
      data: {
        showtimeId: showtime._id,
        paidBookings,
        ticketsSold,
        revenue
      }
    })
  } catch (err) {
    console.error("getShowtimeRevenue error:", err)
    return res.status(500).json({ success: false, message: "Server error while calculating showtime revenue" })
  }
}






const getMoviePerformance = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid movie ID format" })
    }

    const movie = await Movie.findById(req.params.id)
    if (!movie) {
      return res.status(404).json({ success: false, message: "Movie not found" })
    }

    const [totalShowtimes, salesResult] = await Promise.all([
      Showtime.countDocuments({ movie: movie._id }),
      Booking.aggregate([
        {
          $match: {
            movie: new mongoose.Types.ObjectId(req.params.id),
            paymentStatus: "paid"
          }
        },
        {
          $group: {
            _id: null,
            paidBookings: { $sum: 1 },
            ticketsSold: { $sum: { $size: { $ifNull: ["$seats", []] } } },
            revenue: { $sum: "$totalAmount" }
          }
        }
      ])
    ])

    const paidBookings = salesResult[0]?.paidBookings || 0
    const ticketsSold = salesResult[0]?.ticketsSold || 0
    const revenue = salesResult[0]?.revenue || 0

    return res.status(200).json({
      success: true,
      performance: {
        movie: {
          id: movie._id,
          title: movie.title,
          posterUrl: movie.posterUrl,
          status: movie.status
        },
        showtimes: totalShowtimes,
        paidBookings,
        ticketsSold,
        revenue
      }
    })
  } catch (err) {
    console.error("getMoviePerformance error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching movie performance" })
  }
}






const getScreenPerformance = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid screen ID format" })
    }

    const screen = await Screen.findById(req.params.id)
    if (!screen) {
      return res.status(404).json({ success: false, message: "Screen not found" })
    }

    const [totalShowtimes, showtimesList, salesResult] = await Promise.all([
      Showtime.countDocuments({ screen: screen._id }),
      Showtime.find({ screen: screen._id }).select("bookedSeats"),
      Booking.aggregate([
        {
          $match: {
            screen: new mongoose.Types.ObjectId(req.params.id),
            paymentStatus: "paid"
          }
        },
        {
          $group: {
            _id: null,
            paidBookings: { $sum: 1 },
            ticketsSold: { $sum: { $size: { $ifNull: ["$seats", []] } } },
            totalRevenue: { $sum: "$totalAmount" }
          }
        }
      ])
    ])

    const ticketsSold = salesResult[0]?.ticketsSold || 0
    const totalRevenue = salesResult[0]?.totalRevenue || 0

    
    let averageOccupancy = 0
    if (totalShowtimes > 0 && screen.totalSeats > 0) {
      const totalOccupiedSeats = showtimesList.reduce(
        (sum, st) => sum + (Array.isArray(st.bookedSeats) ? st.bookedSeats.length : 0),
        0
      )
      const totalPossibleSeats = totalShowtimes * screen.totalSeats
      averageOccupancy = Math.round((totalOccupiedSeats / totalPossibleSeats) * 100)
    }

    return res.status(200).json({
      success: true,
      performance: {
        screen: {
          id: screen._id,
          name: screen.name,
          screenType: screen.screenType,
          totalSeats: screen.totalSeats
        },
        totalShowtimes,
        ticketsSold,
        totalRevenue,
        averageOccupancy
      }
    })
  } catch (err) {
    console.error("getScreenPerformance error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching screen performance" })
  }
}

module.exports = {
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
}
