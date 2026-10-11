const jwt = require("jsonwebtoken")
const User = require("../models/User.model")

// @desc    Verify JWT token and attach user to request
// @usage   Place before any protected route handler
const authenticateUser = async (req, res, next) => {
  // Check Authorization header exists and starts with "Bearer "
  if (!req.headers.authorization || !req.headers.authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    })
  }

  // Extract token
  const token = req.headers.authorization.split(" ")[1]

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    })
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // Find user — exclude password from req.user
    const user = await User.findById(decoded.id).select("-password")

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token"
      })
    }

    if (
      user.deletedAt ||
      (decoded.authVersion || 0) !== (user.authVersion || 0)
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired token"
      })
    }

    // Attach user to request
    req.user = user

    next()

  } catch (error) {
    // Handles TokenExpiredError, JsonWebTokenError, etc.
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    })
  }
}

module.exports = authenticateUser