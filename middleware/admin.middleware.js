// @desc    Verify that the authenticated user has admin role
// @usage   Place AFTER authenticateUser middleware on admin-only routes
// @example router.get("/admin-only", authenticateUser, authorizeAdmin, handler)
const authorizeAdmin = (req, res, next) => {
  if (req.user && req.user.role === "admin") {
    next()
  } else {
    return res.status(403).json({
      success: false,
      message: "Admin access required"
    })
  }
}

module.exports = authorizeAdmin