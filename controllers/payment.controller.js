const crypto = require("crypto")
const axios = require("axios")
const mongoose = require("mongoose")
const Booking = require("../models/Booking.model")
const Showtime = require("../models/Showtime.model")
const { sendBookingConfirmationEmail } = require("../services/email.service")



const getPaystackConfig = () => {
  const secret = process.env.PAYSTACK_SECRET_KEY
  const baseUrl = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co"
  return { secret, baseUrl }
}





const INITIALIZATION_COOLDOWN_MS = 5 * 60 * 1000



const PAYMENT_REF_PREFIX = "PAY-"

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")


const findBookingByPaymentReference = async (cleanRef, populateQuery) => {
  let query = Booking.findOne({
    $or: [{ paymentReference: cleanRef }, { bookingReference: cleanRef }]
  })

  if (populateQuery) query = query.populate(populateQuery)

  const exact = await query
  if (exact) return exact

  
  
  if (!cleanRef.startsWith(PAYMENT_REF_PREFIX)) return null

  let fallback = Booking.findOne({
    paymentReference: { $regex: escapeRegExp(cleanRef), $options: "i" }
  })

  if (populateQuery) fallback = fallback.populate(populateQuery)

  return fallback
}


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

    
    const isOwner = booking.user && booking.user._id.toString() === req.user._id.toString()
    if (!isOwner) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to initialize payment for this booking"
      })
    }

    
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

    
    const now = new Date()
    if (booking.expiresAt && booking.expiresAt < now) {
      booking.bookingStatus = "expired"
      await booking.save()

      
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

    
    const amountInKobo = Math.round(booking.totalAmount * 100)

    
    const customerEmail = req.user.email || booking.user?.email
    if (!customerEmail) {
      return res.status(400).json({
        success: false,
        message: "User email is required for payment initialization"
      })
    }

    
    const paymentRef = `PAY-${booking.bookingReference}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`

    
    
    
    
    
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






const verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params

    if (!reference || !String(reference).trim()) {
      return res.status(400).json({ success: false, message: "Payment reference is required" })
    }

    const cleanRef = String(reference).trim()

    
    
    
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

    
    const isOwner = booking.user && booking.user._id.toString() === req.user._id.toString()
    const isAdmin = req.user.role === "admin"

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to verify this payment"
      })
    }

    
    if (booking.paymentStatus === "paid" && booking.bookingStatus === "confirmed") {
      
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

    
    if (paystackData.status !== "success") {
      booking.paymentStatus = "failed"
      
      
      
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

    
    const showtimeId = booking.showtime?._id || booking.showtime
    const seatNumbers = Array.isArray(booking.seats) ? booking.seats.map((s) => s.seatNumber) : []

    if (showtimeId && seatNumbers.length > 0) {
      
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

    
    booking.paymentStatus = "paid"
    booking.bookingStatus = "confirmed"
    booking.paidAt = paystackData.paid_at ? new Date(paystackData.paid_at) : new Date()
    booking.confirmedAt = new Date()
    booking.paymentChannel = paystackData.channel || "card"
    booking.paymentReference = paystackData.reference || cleanRef
    booking.paymentFailureReason = null

    await booking.save()

    
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






const paystackWebhook = async (req, res) => {
  try {
    const paystackSignature = req.headers["x-paystack-signature"]
    const secret = process.env.PAYSTACK_SECRET_KEY

    if (!paystackSignature || !secret) {
      return res.status(401).json({ success: false, message: "Missing webhook signature or secret" })
    }

    
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

    
    if (event.event === "charge.success") {
      const data = event.data
      const reference = data.reference
      const paidKobo = data.amount

      if (reference) {
        
        
        const booking = await findBookingByPaymentReference(reference, [
          { path: "user", select: "name email" },
          { path: "movie", select: "title posterUrl" },
          { path: "screen", select: "name screenType" },
          { path: "showtime", select: "showDate startTime" }
        ])

        if (booking) {
          
          if (booking.bookingStatus !== "confirmed" || booking.paymentStatus !== "paid") {
            const expectedKobo = Math.round(booking.totalAmount * 100)

            if (paidKobo === expectedKobo) {
              
              booking.paymentStatus = "paid"
              booking.bookingStatus = "confirmed"
              booking.paidAt = data.paid_at ? new Date(data.paid_at) : new Date()
              booking.confirmedAt = new Date()
              booking.paymentChannel = data.channel || "card"
              booking.paymentReference = reference

              await booking.save()

              
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