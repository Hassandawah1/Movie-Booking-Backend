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




router.post("/", authenticateUser, authorizeAdmin, createShowtime)




router.get("/", getAllShowtimes)



router.get("/movie/:movieId", getShowtimesForMovie)


router.get("/:showtimeId/seats", getShowtimeSeats)


router.get("/:id", getShowtimeById)




router.put("/:id", authenticateUser, authorizeAdmin, updateShowtime)


router.delete("/:id", authenticateUser, authorizeAdmin, deleteShowtime)

module.exports = router