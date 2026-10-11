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




router.post("/", authenticateUser, authorizeAdmin, createScreen)


router.get("/", authenticateUser, authorizeAdmin, getAllScreens)


router.get("/:id", authenticateUser, authorizeAdmin, getScreenById)


router.put("/:id", authenticateUser, authorizeAdmin, updateScreen)


router.delete("/:id", authenticateUser, authorizeAdmin, deleteScreen)

module.exports = router
