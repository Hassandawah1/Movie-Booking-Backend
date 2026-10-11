const crypto = require("crypto")
const axios = require("axios")
const mongoose = require("mongoose")
const Booking = require("../models/Booking.model")
const Showtime = require("../models/Showtime.model")
const { sendBookingConfirmationEmail } = require("../services/email.service")

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getPaystackConfig = () => {
  const secret = process.env.PAYSTACK_SECRET_KEY
  const baseUrl = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co"
  return { secret, baseUrl }
}

// ─── Payment reference helpers ───────────────────────────────────────────────

// Allowed "no newer attempt" window before a customer may start a fresh
// transaction on the same booking.
const INITIALIZATION_COOLDOWN_MS = 5 * 60 * 1000

// Mirrors the reference format generated at initialization:
//   PAY-<bookingReference>-<hex>
const PAYMENT_REF_PREFIX = "PAY-"

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Find the booking that a payment reference belongs to.
 *
 * The booking stores only the MOST RECENT Paystack reference, so a reference
 * from an earlier initialization attempt would otherwise be orphaned and its
 * callback would 404 even though the customer had really paid. Because every
 * reference is built as `PAY-<bookingReference>-<hex>`, a stale reference can
 * still be matched back to its booking by substring.
 */
const findBookingByPaymentReference = async (cleanRef, populateQuery) => {
  let query = Booking.findOne({
    $or: [{ paymentReference: cleanRef }, { bookingReference: cleanRef }]
  })

  if (populateQuery) query = query.populate(populateQuery)

  const exact = await query
  if (exact) return exact

  // Only attempt substring recovery for references we generated ourselves,
  // so arbitrary strings cannot be used to probe other customers' bookings.
  if (!cleanRef.startsWith(PAYMENT_REF_PREFIX)) return null

  let fallback = Booking.findOne({
    paymentReference: { $regex: escapeRegExp(cleanRef), $options: "i" }
  })

  if (populateQuery) fallback = fallback.populate(populateQuery)

  return fallback
}

/**
 * Claims the right to start a new Paystack transaction for this booking.
 * Returns true for the first caller only, so two concurrent requests (double
 * click, refreshed tab, React StrictMode) cannot open two live transactions.
 */
const claimPaymentInitialization = async (bookingId) => {
  const claimed = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      $or: [
        { paymentInitializingAt: { $exists: false } },
        { paymentInitializingAt: null },
        { paymentInitializingAt: { $lt: new Date(Date.now() - 60 * 1000) } }
      ]
    },
    { $set: { paymentInitializingAt: new Date() } },
    { returnDocument: "after" }
  )

  return Boolean(claimed)
}

const releasePaymentInitializationClaim = async (bookingId) => {
  try {
    await Booking.updateOne({ _id: bookingId }, { $set: { paymentInitializingAt: null } })
  } catch (err) {
    console.error("releasePaymentInitializationClaim error:", err.message)
  }
}

const trySendConfirmationEmail = async (booking) => {
  if (booking.paymentStatus !== "paid" || booking.bookingStatus !== "confirmed") return false
  if (booking.confirmationEmailSent) return true

  const sendingAt = new Date()
  try {
    const claim = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        paymentStatus: "paid",
        bookingStatus: "confirmed",
        confirmationEmailSent: { $ne: true },
        $or: [
          { confirmationEmailSendingAt: { $exists: false } },
          { confirmationEmailSendingAt: null },
          { confirmationEmailSendingAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }
        ]
      },
      { $set: { confirmationEmailSendingAt: sendingAt } },
      { returnDocument: "after" }
    )
    if (!claim) return false

    const emailResult = await sendBookingConfirmationEmail(booking, booking.user)
    if (!emailResult.success) {
      console.warn("Booking confirmation email could not be sent", {
        bookingReference: booking.bookingReference
      })
      await Booking.updateOne(
        { _id: booking._id, confirmationEmailSendingAt: sendingAt },
        { $unset: { confirmationEmailSendingAt: 1 } }
      )
      return false
    }

    const sentAt = new Date()
    const updated = await Booking.updateOne(
      {
        _id: booking._id,
        paymentStatus: "paid",
        bookingStatus: "confirmed",
        confirmationEmailSendingAt: sendingAt
      },
      {
        $set: {
          confirmationEmailSent: true,
          confirmationEmailSentAt: sentAt
        },
        $unset: { confirmationEmailSendingAt: 1 }
      }
    )
    if (updated.matchedCount !== 1) {
      console.error("Confirmation email was delivered but its sent status could not be recorded", {
        bookingReference: booking.bookingReference
      })
      return false
    }

    booking.confirmationEmailSent = true
    booking.confirmationEmailSentAt = sentAt
    return true
  } catch (err) {
    try {
      await Booking.updateOne(
        { _id: booking._id, confirmationEmailSendingAt: sendingAt },
        { $unset: { confirmationEmailSendingAt: 1 } }
      )
    } catch (releaseErr) {
      console.error("Confirmation email send lock could not be released", {
        error: releaseErr.message,
        bookingReference: booking.bookingReference
      })
    }
    console.error("Booking confirmation email tracking failed", {
      error: err.message,
      bookingReference: booking.bookingReference
    })
    return false
  }
}

// ─── Initialize Payment ──────────────────────────────────────────────────────

// @desc    Initialize a Paystack transaction for a pending booking
// @route   POST /api/payments/initialize/:bookingId
// @access  Private (Owner only)
const initializePayment = async (req, res) => {
  let claimBookingId = null

  try {
    const { bookingId } = req.params

    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format" })
    }

    const booking = await Booking.findById(bookingId)
      .populate("user", "name email")
      .populate("movie", "title posterUrl")
      .populate("screen", "name screenType")
      .populate("showtime", "showDate startTime")

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" })
    }

    // Ownership check — customers cannot pay for other people's bookings
    const isOwner = booking.user && booking.user._id.toString() === req.user._id.toString()
    if (!isOwner) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to initialize payment for this booking"
      })
    }

    // Status checks
    if (booking.bookingStatus === "confirmed" || booking.paymentStatus === "paid") {
      return res.status(400).json({
        success: false,
        message: "Payment has already been completed for this booking"
      })
    }

    if (booking.bookingStatus === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Cannot pay for a cancelled booking"
      })
    }

    // Check expiration
    const now = new Date()
    if (booking.expiresAt && booking.expiresAt < now) {
      booking.bookingStatus = "expired"
      await booking.save()

      // Release seats from showtime
      const seatNumbers = Array.isArray(booking.seats)
        ? booking.seats.map((s) => s.seatNumber)
        : []
      if (seatNumbers.length > 0 && booking.showtime) {
        await Showtime.updateOne(
          { _id: booking.showtime._id || booking.showtime },
          { $pull: { bookedSeats: { $in: seatNumbers } } }
        )
      }

      return res.status(400).json({
        success: false,
        message: "This booking reservation has expired. Please select your seats again."
      })
    }

    if (!booking.totalAmount || booking.totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking amount"
      })
    }

    // Calculate amount in kobo (Paystack expects amount in lowest currency unit: 1 Naira = 100 kobo)
    const amountInKobo = Math.round(booking.totalAmount * 100)

    // Customer email
    const customerEmail = req.user.email || booking.user?.email
    if (!customerEmail) {
      return res.status(400).json({
        success: false,
        message: "User email is required for payment initialization"
      })
    }

    // Unique payment reference: PAY-<bookingReference>-<hex>
    const paymentRef = `PAY-${booking.bookingReference}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`

    // ── Duplicate initialization guard ──
    // If a transaction was already opened for this booking very recently, reuse
    // it instead of opening a second one. Two live transactions would strand the
    // first reference (the booking can only remember one), so a customer paying
    // on the original checkout page could never be matched back to the booking.
    const existingRef = booking.paymentReference
    const recentlyInitialized =
      existingRef &&
      booking.updatedAt &&
      Date.now() - new Date(booking.updatedAt).getTime() < INITIALIZATION_COOLDOWN_MS

    if (recentlyInitialized) {
      return res.status(200).json({
        success: true,
        reused: true,
        message: "A payment is already in progress for this booking",
        payment: {
          authorizationUrl: `https://checkout.paystack.com/${booking.paymentAccessCode}`,
          accessCode: booking.paymentAccessCode,
          reference: existingRef
        },
        booking: {
          id: booking._id,
          bookingReference: booking.bookingReference,
          totalAmount: booking.totalAmount,
          expiresAt: booking.expiresAt
        }
      })
    }

    // Atomically claim this initialization so concurrent requests cannot both
    // proceed to create a Paystack transaction.
    const claimed = await claimPaymentInitialization(booking._id)
    claimBookingId = booking._id
    if (!claimed) {
      return res.status(200).json({
        success: true,
        reused: true,
        message: "A payment is already being initialized for this booking. Please wait a moment.",
        payment: {
          authorizationUrl: booking.paymentAccessCode
            ? `https://checkout.paystack.com/${booking.paymentAccessCode}`
            : null,
          accessCode: booking.paymentAccessCode || null,
          reference: existingRef || null
        },
        booking: {
          id: booking._id,
          bookingReference: booking.bookingReference,
          totalAmount: booking.totalAmount,
          expiresAt: booking.expiresAt
        }
      })
    }

    const { secret, baseUrl } = getPaystackConfig()
    if (!secret) {
      await releasePaymentInitializationClaim(booking._id)
      return res.status(500).json({
        success: false,
        message: "Payment gateway is not configured on server"
      })
    }

    // Call Paystack Initialize Endpoint
    const paystackResponse = await axios.post(
      `${baseUrl}/transaction/initialize`,
      {
        email: customerEmail,
        amount: amountInKobo,
        reference: paymentRef,
        callback_url:
          req.body?.callbackUrl ||
          `${process.env.FRONTEND_URL || "http://localhost:5173"}/payment/callback`,
        metadata: {
          bookingId: booking._id.toString(),
          bookingReference: booking.bookingReference,
          userId: req.user._id.toString()
        }
      },
      {
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json"
        }
      }
    )

    if (!paystackResponse.data || !paystackResponse.data.status) {
      await releasePaymentInitializationClaim(booking._id)
      return res.status(502).json({
        success: false,
        message: "Failed to initialize payment with gateway"
      })
    }

    const { authorization_url, access_code, reference } = paystackResponse.data.data

    // Persist payment reference on booking
    booking.paymentReference = reference || paymentRef
    booking.paymentAccessCode = access_code || null
    booking.paymentInitializingAt = null
    await booking.save()

    return res.status(200).json({
      success: true,
      message: "Payment initialized successfully",
      payment: {
        authorizationUrl: authorization_url,
        accessCode: access_code,
        reference: reference || paymentRef
      },
      booking: {
        id: booking._id,
        bookingReference: booking.bookingReference,
        totalAmount: booking.totalAmount,
        expiresAt: booking.expiresAt
      }
    })
  } catch (err) {
    console.error({
      errorName: err.name,
      errorMessage: err.message,
      errorCode: err.code,
      providerStatus: err.response?.status,
      providerMessage: err.response?.data?.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    }, "Payment initialization failed")
    if (claimBookingId) {
      await releasePaymentInitializationClaim(claimBookingId)
    }
    const isProviderError = axios.isAxiosError(err)
    const gatewayMessage = err.response?.data?.message ||
      (isProviderError
        ? "Unable to reach the payment provider. Please check your connection and try again."
        : "Server error while initializing payment")
    return res.status(isProviderError ? 502 : 500).json({
      success: false,
      message: gatewayMessage
    })
  }
}

// ─── Verify Payment ──────────────────────────────────────────────────────────

// @desc    Verify Paystack transaction status and confirm booking
// @route   GET /api/payments/verify/:reference
// @access  Private (Owner or Admin)
const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params

    if (!reference || !String(reference).trim()) {
      return res.status(400).json({ success: false, message: "Payment reference is required" })
    }

    const cleanRef = String(reference).trim()

    // Find booking by paymentReference (or fallback matching bookingReference).
    // A reference from an earlier, superseded initialization attempt is matched
    // back to its booking by substring so a completed payment is never orphaned.
    const booking = await findBookingByPaymentReference(cleanRef, [
      { path: "user", select: "name email" },
      { path: "movie", select: "title posterUrl runtime" },
      { path: "screen", select: "name screenType totalSeats" },
      { path: "showtime", select: "showDate startTime standardPrice vipPrice bookedSeats" }
    ])

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "No booking found matching this payment reference"
      })
    }

    // Ownership check (Admins can verify any payment)
    const isOwner = booking.user && booking.user._id.toString() === req.user._id.toString()
    const isAdmin = req.user.role === "admin"

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to verify this payment"
      })
    }

    // ── Idempotent Check: If already confirmed & paid, return current state ──
    if (booking.paymentStatus === "paid" && booking.bookingStatus === "confirmed") {
      // Ensure confirmation email was triggered if missed earlier
      if (!booking.confirmationEmailSent) {
        await trySendConfirmationEmail(booking)
      }

      return res.status(200).json({
        success: true,
        message: "Payment already verified and booking is confirmed",
        booking: {
          id: booking._id,
          bookingReference: booking.bookingReference,
          totalAmount: booking.totalAmount,
          bookingStatus: booking.bookingStatus,
          paymentStatus: booking.paymentStatus,
          paymentReference: booking.paymentReference,
          paidAt: booking.paidAt,
          confirmedAt: booking.confirmedAt,
          paymentChannel: booking.paymentChannel,
          confirmationEmailSent: booking.confirmationEmailSent
        }
      })
    }

    // Call Paystack Verify Endpoint
    const { secret, baseUrl } = getPaystackConfig()
    if (!secret) {
      return res.status(500).json({
        success: false,
        message: "Payment gateway is not configured on server"
      })
    }

    const paystackResponse = await axios.get(
      `${baseUrl}/transaction/verify/${encodeURIComponent(cleanRef)}`,
      {
        headers: {
          Authorization: `Bearer ${secret}`
        }
      }
    )

    const paystackData = paystackResponse.data?.data
    if (!paystackData) {
      return res.status(502).json({
        success: false,
        message: "Invalid response from payment gateway"
      })
    }

    // Verify transaction status from Paystack
    if (paystackData.status !== "success") {
      booking.paymentStatus = "failed"
      // Record WHY, so the UI can distinguish "the customer abandoned checkout"
      // from "the gateway declined the payment". Paystack reports an unfinished
      // checkout as "abandoned", which is not a declined payment.
      booking.paymentFailureReason = paystackData.status
      await booking.save()

      return res.status(400).json({
        success: false,
        message: `Payment verification failed: Gateway reported status '${paystackData.status}'`,
        gatewayStatus: paystackData.status,
        failureReason: paystackData.status,
        booking: {
          id: booking._id,
          bookingReference: booking.bookingReference
        }
      })
    }

    // ── Critical Amount Verification (Never Trust Client Amount) ──
    const expectedKobo = Math.round(booking.totalAmount * 100)
    const paidKobo = paystackData.amount

    if (paidKobo !== expectedKobo) {
      console.error(
        `Amount mismatch for booking ${booking.bookingReference}: Expected ${expectedKobo} kobo, received ${paidKobo} kobo.`
      )
      booking.paymentStatus = "failed"
      booking.paymentFailureReason = "amount-mismatch"
      await booking.save()

      return res.status(400).json({
        success: false,
        message: `Payment amount mismatch: Expected ₦${booking.totalAmount} (${expectedKobo} kobo), but payment was ₦${paidKobo / 100} (${paidKobo} kobo). Booking not confirmed.`,
        failureReason: "amount-mismatch",
        booking: {
          id: booking._id,
          bookingReference: booking.bookingReference
        }
      })
    }

    // ── Ensure seats stay permanently locked in Showtime ──
    const showtimeId = booking.showtime?._id || booking.showtime
    const seatNumbers = Array.isArray(booking.seats) ? booking.seats.map((s) => s.seatNumber) : []

    if (showtimeId && seatNumbers.length > 0) {
      // Check for seat conflicts if payment is verified after booking expired/cancelled
      if (booking.bookingStatus === "expired" || booking.bookingStatus === "cancelled") {
        const conflictingBooking = await Booking.findOne({
          showtime: showtimeId,
          _id: { $ne: booking._id },
          bookingStatus: { $in: ["pending-payment", "confirmed"] },
          "seats.seatNumber": { $in: seatNumbers }
        })

        if (conflictingBooking) {
          console.error(`Seat conflict on post-expiry payment for booking ${booking.bookingReference}`)
          return res.status(409).json({
            success: false,
            message: "Payment was processed for an expired reservation, but the seats were already booked by another customer. Please contact administration."
          })
        }
      }

      await Showtime.updateOne(
        { _id: showtimeId },
        { $addToSet: { bookedSeats: { $each: seatNumbers } } }
      )
    }

    // ── Update Booking to Confirmed & Paid ──
    booking.paymentStatus = "paid"
    booking.bookingStatus = "confirmed"
    booking.paidAt = paystackData.paid_at ? new Date(paystackData.paid_at) : new Date()
    booking.confirmedAt = new Date()
    booking.paymentChannel = paystackData.channel || "card"
    booking.paymentReference = paystackData.reference || cleanRef
    booking.paymentFailureReason = null

    await booking.save()

    // ── Send Booking Confirmation Email (Non-blocking failure) ──
    const emailSent = await trySendConfirmationEmail(booking)

    return res.status(200).json({
      success: true,
      message: "Payment verified and booking confirmed successfully",
      booking: {
        id: booking._id,
        bookingReference: booking.bookingReference,
        totalAmount: booking.totalAmount,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        paymentReference: booking.paymentReference,
        paymentFailureReason: booking.paymentFailureReason || null,
        paidAt: booking.paidAt,
        confirmedAt: booking.confirmedAt,
        paymentChannel: booking.paymentChannel,
        confirmationEmailSent: emailSent
      }
    })
  } catch (err) {
    console.error("verifyPayment error:", {
      error: err.response?.data || err.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    })
    const gatewayMessage = err.response?.data?.message || "Server error while verifying payment"
    return res.status(err.response?.status || 500).json({
      success: false,
      message: gatewayMessage
    })
  }
}

// ─── Get Payment Status for a Booking ────────────────────────────────────────

// @desc    Get payment and confirmation status for a specific booking
// @route   GET /api/payments/booking/:bookingId
// @access  Private (Owner or Admin)
const getBookingPaymentStatus = async (req, res) => {
  try {
    const { bookingId } = req.params

    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format" })
    }

    const booking = await Booking.findById(bookingId).populate("user", "name email")

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" })
    }

    const isOwner = booking.user && booking.user._id.toString() === req.user._id.toString()
    const isAdmin = req.user.role === "admin"

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to view payment status for this booking"
      })
    }

    return res.status(200).json({
      success: true,
      payment: {
        bookingId: booking._id,
        bookingReference: booking.bookingReference,
        totalAmount: booking.totalAmount,
        bookingStatus: booking.bookingStatus,
        paymentStatus: booking.paymentStatus,
        paymentReference: booking.paymentReference || null,
        paymentChannel: booking.paymentChannel || null,
        paymentFailureReason: booking.paymentFailureReason || null,
        paidAt: booking.paidAt || null,
        confirmedAt: booking.confirmedAt || null,
        confirmationEmailSent: booking.confirmationEmailSent
      }
    })
  } catch (err) {
    console.error("getBookingPaymentStatus error:", {
      error: err.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    })
    return res.status(500).json({ success: false, message: "Server error while fetching payment status" })
  }
}

// ─── Paystack Webhook Handler ────────────────────────────────────────────────

// @desc    Handle Paystack Webhook events (e.g. charge.success)
// @route   POST /api/payments/webhook
// @access  Public (Validated with Paystack HMAC-SHA512 Signature)
const paystackWebhook = async (req, res) => {
  try {
    const paystackSignature = req.headers["x-paystack-signature"]
    const secret = process.env.PAYSTACK_SECRET_KEY

    if (!paystackSignature || !secret) {
      return res.status(401).json({ success: false, message: "Missing webhook signature or secret" })
    }

    // Verify HMAC-SHA512 signature using raw request body
    const payload = req.rawBody ? req.rawBody : JSON.stringify(req.body)
    const expectedSignature = crypto
      .createHmac("sha512", secret)
      .update(payload)
      .digest("hex")

    if (expectedSignature !== paystackSignature) {
      console.warn("Paystack Webhook: Invalid HMAC SHA512 signature received")
      return res.status(401).json({ success: false, message: "Invalid webhook signature" })
    }

    const event = req.body

    // Handle charge.success event
    if (event.event === "charge.success") {
      const data = event.data
      const reference = data.reference
      const paidKobo = data.amount

      if (reference) {
        // Same substring recovery as verifyPayment: a webhook for an earlier
        // initialization attempt must still be able to confirm its booking.
        const booking = await findBookingByPaymentReference(reference, [
          { path: "user", select: "name email" },
          { path: "movie", select: "title posterUrl" },
          { path: "screen", select: "name screenType" },
          { path: "showtime", select: "showDate startTime" }
        ])

        if (booking) {
          // Idempotency: skip if already confirmed and paid
          if (booking.bookingStatus !== "confirmed" || booking.paymentStatus !== "paid") {
            const expectedKobo = Math.round(booking.totalAmount * 100)

            if (paidKobo === expectedKobo) {
              // Confirm booking
              booking.paymentStatus = "paid"
              booking.bookingStatus = "confirmed"
              booking.paidAt = data.paid_at ? new Date(data.paid_at) : new Date()
              booking.confirmedAt = new Date()
              booking.paymentChannel = data.channel || "card"
              booking.paymentReference = reference

              await booking.save()

              // Lock seats permanently
              const showtimeId = booking.showtime?._id || booking.showtime
              const seatNumbers = Array.isArray(booking.seats)
                ? booking.seats.map((s) => s.seatNumber)
                : []

              if (showtimeId && seatNumbers.length > 0) {
                if (booking.bookingStatus === "expired" || booking.bookingStatus === "cancelled") {
                  const conflictingBooking = await Booking.findOne({
                    showtime: showtimeId,
                    _id: { $ne: booking._id },
                    bookingStatus: { $in: ["pending-payment", "confirmed"] },
                    "seats.seatNumber": { $in: seatNumbers }
                  })

                  if (conflictingBooking) {
                    console.error(`Webhook seat conflict for booking ${booking.bookingReference}. Seats were already rebooked.`)
                    return res.status(200).json({ status: "conflict_detected" })
                  }
                }

                await Showtime.updateOne(
                  { _id: showtimeId },
                  { $addToSet: { bookedSeats: { $each: seatNumbers } } }
                )
              }

            } else {
              console.error(
                `Webhook: Amount mismatch for booking ${booking.bookingReference}. Expected ${expectedKobo}, got ${paidKobo}.`
              )
            }

          }
          if (booking.paymentStatus === "paid" && booking.bookingStatus === "confirmed") {
            await trySendConfirmationEmail(booking)
          }
        }
      }
    }

    // Always acknowledge webhook with 200 OK
    return res.status(200).json({ status: "success" })
  } catch (err) {
    console.error("paystackWebhook error:", {
      error: err.message,
      id: req.id,
      method: req.method,
      url: req.originalUrl
    })
    return res.status(500).json({ success: false, message: "Webhook processing error" })
  }
}

module.exports = {
  initializePayment,
  verifyPayment,
  getBookingPaymentStatus,
  paystackWebhook
}