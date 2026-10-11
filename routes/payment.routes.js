const express = require("express")
const router = express.Router()

const {
  initializePayment,
  verifyPayment,
  getBookingPaymentStatus,
  paystackWebhook
} = require("../controllers/payment.controller")

const authenticateUser = require("../middleware/auth.middleware")




router.post("/initialize/:bookingId", authenticateUser, initializePayment)


router.get("/verify/:reference", authenticateUser, verifyPayment)


router.get("/booking/:bookingId", authenticateUser, getBookingPaymentStatus)




router.post("/webhook", paystackWebhook)

module.exports = router