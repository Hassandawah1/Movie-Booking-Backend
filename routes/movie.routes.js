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

// ─── Admin: External API routes ───────────────────────────────────────────────
// IMPORTANT: /search and /external/:id must come BEFORE /:id to avoid
// Express treating "search" or "external" as a MongoDB _id

// GET /api/movies/search?query=Inception
router.get("/search", authenticateUser, authorizeAdmin, searchMovies)

// GET /api/movies/external/:externalMovieId
router.get("/external/:externalMovieId", authenticateUser, authorizeAdmin, getExternalMovieDetails)

// POST /api/movies — add a movie from external API to our cinema
router.post("/", authenticateUser, authorizeAdmin, addMovieToCinema)

// ─── Public: Our cinema movie routes ─────────────────────────────────────────

// GET /api/movies or GET /api/movies?status=now-showing
router.get("/", getAllMovies)

// GET /api/movies/:id
router.get("/:id", getMovieById)

// ─── Admin: Manage existing cinema movies ─────────────────────────────────────

// PUT /api/movies/:id — update status / title / overview
router.put("/:id", authenticateUser, authorizeAdmin, updateMovie)

// DELETE /api/movies/:id
router.delete("/:id", authenticateUser, authorizeAdmin, deleteMovie)

module.exports = router