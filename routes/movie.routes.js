const express = require("express")
const router = express.Router()

const {
  searchMovies,
  getExternalMovieDetails,
  addMovieToCinema,
  getAllMovies,
  getMovieById,
  updateMovie,
  deleteMovie
} = require("../controllers/movie.controller")

const authenticateUser = require("../middleware/auth.middleware")
const authorizeAdmin = require("../middleware/admin.middleware")






router.get("/search", authenticateUser, authorizeAdmin, searchMovies)


router.get("/external/:externalMovieId", authenticateUser, authorizeAdmin, getExternalMovieDetails)


router.post("/", authenticateUser, authorizeAdmin, addMovieToCinema)




router.get("/", getAllMovies)


router.get("/:id", getMovieById)




router.put("/:id", authenticateUser, authorizeAdmin, updateMovie)


router.delete("/:id", authenticateUser, authorizeAdmin, deleteMovie)

module.exports = router