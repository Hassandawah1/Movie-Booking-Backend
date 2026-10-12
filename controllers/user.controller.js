const User = require("../models/User.model")
const mongoose = require("mongoose")
const crypto = require("crypto")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const { sendWelcomeEmail } = require("../services/email.service")
const Booking = require("../models/Booking.model")




const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body

    
    if (typeof name !== "string" || !name.trim() || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      })
    }

    
    const trimmedName = name.trim()
    if (Array.from(trimmedName).length < 3) {
      return res.status(400).json({
        success: false,
        message: "Name must be at least 3 characters long"
      })
    }

    if (!/^[\p{L}\p{M}]+(?:[ '\u2019.-][\p{L}\p{M}]+)*$/u.test(trimmedName)) {
      return res.status(400).json({
        success: false,
        message: "Name can only contain letters, spaces, hyphens, apostrophes, and periods"
      })
    }

    
    const emailRegex = /^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i
    if (typeof email !== "string" || !emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address"
      })
    }

    
    if (typeof password !== "string" || !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9\s])\S{8,}$/.test(password)) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters and include uppercase, lowercase, number, and special character"
      })
    }

    
    const normalizedEmail = email.toLowerCase().trim()

    
    const userExists = await User.findOne({ email: normalizedEmail })
    if (userExists) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists"
      })
    }

    
    const hashedPassword = await bcrypt.hash(password, 10)

    
    const user = await User.create({
      name: trimmedName,
      email: normalizedEmail,
      password: hashedPassword,
      role: "user"
    })

    try {
      const welcomeEmail = await sendWelcomeEmail(user)
      if (!welcomeEmail.success) {
        console.warn("Welcome email could not be sent after registration", { userId: user._id })
      }
    } catch (emailErr) {
      console.error("Welcome email failed after registration", {
        error: emailErr.message,
        userId: user._id
      })
    }

    
    const token = jwt.sign(
      { id: user._id, role: user.role, authVersion: user.authVersion || 0 },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    )

    
    res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      token
    })

  } catch (error) {
    console.error("Error in registerUser:", {
      error: error.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    })
    res.status(500).json({
      success: false,
      message: "Server error during registration"
    })
  }
}




const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body

    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      })
    }

    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        success: false,
        message: "The database is currently unavailable. Please try again shortly."
      })
    }

    
    const normalizedEmail = email.toLowerCase().trim()

    
    const user = await User.findOne({ email: normalizedEmail })

    
    if (!user || user.deletedAt || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      })
    }

    
    const token = jwt.sign(
      { id: user._id, role: user.role, authVersion: user.authVersion || 0 },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    )

    
    res.status(200).json({
      success: true,
      message: "Login successful",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      },
      token
    })

  } catch (error) {
    console.error("Error in loginUser:", {
      error: error.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    })

    if (mongoose.connection.readyState !== 1 || error.name === "MongooseServerSelectionError") {
      return res.status(503).json({
        success: false,
        message: "The database is currently unavailable. Please try again shortly."
      })
    }

    res.status(500).json({
      success: false,
      message: "Server error during login"
    })
  }
}




const getCurrentUser = (req, res) => {
  try {
    res.status(200).json({
      success: true,
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role
      }
    })
  } catch (error) {
    console.error("Error in getCurrentUser:", {
      error: error.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    })
    res.status(500).json({
      success: false,
      message: "Server error fetching user profile"
    })
  }
}

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {}
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required"
      })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long"
      })
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password"
      })
    }

    const user = await User.findById(req.user._id)
    if (!user || user.deletedAt) {
      return res.status(404).json({ success: false, message: "Account not found" })
    }

    if (!(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" })
    }

    user.password = await bcrypt.hash(newPassword, 10)
    user.authVersion = (user.authVersion || 0) + 1
    await user.save()

    const token = jwt.sign(
      { id: user._id, role: user.role, authVersion: user.authVersion },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    )

    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    })
  } catch (error) {
    console.error({
      error: error.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    }, "Error changing password")
    return res.status(500).json({
      success: false,
      message: "Unable to change password right now"
    })
  }
}

const deleteAccount = async (req, res) => {
  try {
    const { currentPassword, confirmation } = req.body || {}
    if (typeof currentPassword !== "string" || confirmation !== "DELETE") {
      return res.status(400).json({
        success: false,
        message: "Enter your current password and type DELETE to confirm"
      })
    }

    const user = await User.findById(req.user._id)
    if (!user || user.deletedAt) {
      return res.status(404).json({ success: false, message: "Account not found" })
    }

    if (!(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ success: false, message: "Current password is incorrect" })
    }

    if (user.role === "admin" && await User.countDocuments({ role: "admin", deletedAt: null }) <= 1) {
      return res.status(409).json({
        success: false,
        message: "The last administrator account cannot be deleted"
      })
    }

    const activeBooking = await Booking.exists({
      user: user._id,
      bookingStatus: "pending-payment",
      expiresAt: { $gt: new Date() }
    })
    if (activeBooking) {
      return res.status(409).json({
        success: false,
        message: "Cancel or wait for your active reservation to expire before deleting your account"
      })
    }

    user.name = "Deleted User"
    user.email = `deleted-${user._id}@deleted.invalid`
    user.password = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10)
    user.role = "user"
    user.deletedAt = new Date()
    user.authVersion = (user.authVersion || 0) + 1
    await user.save()

    return res.status(200).json({
      success: true,
      message: "Your account has been deleted. Booking and payment records were retained without your personal details."
    })
  } catch (error) {
    console.error({
      error: error.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    }, "Error deleting account")
    return res.status(500).json({
      success: false,
      message: "Unable to delete account right now"
    })
  }
}

module.exports = {
  registerUser,
  loginUser,
  getCurrentUser,
  changePassword,
  deleteAccount
}