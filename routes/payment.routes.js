const express = require("express")
const router = express.Router()

const {
  initializePayment,
  verifyPayment,
  getBookingPaymentStatus,
  paystackWebhook
} = require("../controllers/payment.controller")

const authenticateUser = require("../middleware/auth.middleware")

// ─── Protected Routes (JWT Authentication Required) ───────────────────────────

// POST /api/payments/initialize/:bookingId — Initialize Paystack payment for a booking
router.post("/initialize/:bookingId", authenticateUser, initializePayment)

// GET /api/payments/verify/:reference — Verify payment status directly with Paystack
router.get("/verify/:reference", authenticateUser, verifyPayment)

// GET /api/payments/booking/:bookingId — Check payment state for a user's booking
router.get("/booking/:bookingId", authenticateUser, getBookingPaymentStatus)

// ─── Public Webhook (Secured via Paystack HMAC SHA512 Signature) ──────────────

// POST /api/payments/webhook — Paystack event webhook handler (No JWT)
router.post("/webhook", paystackWebhook)

module.exports = router