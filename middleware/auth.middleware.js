const jwt = require("jsonwebtoken")
const User = require("../models/User.model")



const authenticateUser = async (req, res, next) => {
  
  if (!req.headers.authorization || !req.headers.authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    })
  }

  
  const token = req.headers.authorization.split(" ")[1]

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Authentication required"
    })
  }

  try {
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    
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

    
    req.user = user

    next()

  } catch (error) {
    
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    })
  }
}

module.exports = authenticateUser