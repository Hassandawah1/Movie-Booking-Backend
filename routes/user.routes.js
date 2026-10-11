const express = require("express")
const router = express.Router()
const {
  registerUser,
  loginUser,
  getCurrentUser,
  changePassword,
  deleteAccount
} = require("../controllers/user.controller")
const authenticateUser = require("../middleware/auth.middleware")


router.post("/register", registerUser)
router.post("/login", loginUser)


router.get("/me", authenticateUser, getCurrentUser)
router.put("/me/password", authenticateUser, changePassword)
router.delete("/me", authenticateUser, deleteAccount)

module.exports = router