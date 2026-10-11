const express = require("express")
const router = express.Router()

const {
  createScreen,
  getAllScreens,
  getScreenById,
  updateScreen,
  deleteScreen
} = require("../controllers/screen.controller")

const authenticateUser = require("../middleware/auth.middleware")
const authorizeAdmin = require("../middleware/admin.middleware")

// All screen management routes are admin-only

// POST /api/screens — create a new screen
router.post("/", authenticateUser, authorizeAdmin, createScreen)

// GET /api/screens — list all screens
router.get("/", authenticateUser, authorizeAdmin, getAllScreens)

// GET /api/screens/:id — get single screen
router.get("/:id", authenticateUser, authorizeAdmin, getScreenById)

// PUT /api/screens/:id — update screen
router.put("/:id", authenticateUser, authorizeAdmin, updateScreen)

// DELETE /api/screens/:id — delete screen (blocked if active showtimes)
router.delete("/:id", authenticateUser, authorizeAdmin, deleteScreen)

module.exports = router
