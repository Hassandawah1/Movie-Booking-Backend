const mongoose = require("mongoose")

const seatSchema = new mongoose.Schema(
  {
    seatNumber: {
      type: String,
      required: [true, "Seat number is required"],
      trim: true
    },
    ticketType: {
      type: String,
      enum: ["standard", "vip"],
      required: [true, "Ticket type is required"]
    },
    price: {
      type: Number,
      required: [true, "Seat price is required"],
      min: [0, "Seat price cannot be negative"]
    }
  },
  { _id: false }
)

const bookingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User reference is required"]
    },

    showtime: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Showtime",
      required: [true, "Showtime reference is required"]
    },

    movie: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Movie",
      required: [true, "Movie reference is required"]
    },

    screen: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Screen",
      required: [true, "Screen reference is required"]
    },

    seats: {
      type: [seatSchema],
      required: [true, "At least one seat is required"],
      validate: {
        validator: function (val) {
          return Array.isArray(val) && val.length > 0
        },
        message: "Booking must contain at least one seat"
      }
    },

    bookingReference: {
      type: String,
      required: [true, "Booking reference is required"],
      unique: true,
      trim: true
    },

    totalAmount: {
      type: Number,
      required: [true, "Total amount is required"],
      min: [0, "Total amount cannot be negative"]
    },

    bookingStatus: {
      type: String,
      enum: ["pending-payment", "confirmed", "cancelled", "expired"],
      default: "pending-payment"
    },

    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "failed", "refunded"],
      default: "unpaid"
    },

    expiresAt: {
      type: Date,
      required: [true, "Expiration date is required"]
    },

    // ── Paystack Payment & Confirmation Details (Phase 6) ──
    paymentReference: {
      type: String,
      trim: true
    },

    paymentAccessCode: {
      type: String,
      trim: true
    },

    // Short-lived in-flight lock so two concurrent requests cannot open two
    // live Paystack transactions for the same booking (Phase 12).
    paymentInitializingAt: {
      type: Date,
      default: null
    },

    // Why the last payment attempt did not complete: "abandoned" (customer
    // closed checkout), "failed" (gateway declined), "amount-mismatch", etc.
    // Lets the UI say "not completed" instead of wrongly saying "failed".
    paymentFailureReason: {
      type: String,
      trim: true
    },

    paymentChannel: {
      type: String,
      trim: true
    },

    paidAt: {
      type: Date
    },

    confirmedAt: {
      type: Date
    },

    confirmationEmailSent: {
      type: Boolean,
      default: false
    },

    confirmationEmailSentAt: {
      type: Date
    },

    confirmationEmailSendingAt: {
      type: Date,
      default: null
    },

    reservationEmailSentAt: {
      type: Date
    },

    cancellationEmailSentAt: {
      type: Date
    },

    showtimeCancellationEmailSentAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
)

// Index for query performance and status lookups
bookingSchema.index({ user: 1, createdAt: -1 })
bookingSchema.index({ showtime: 1, bookingStatus: 1 })
bookingSchema.index({ expiresAt: 1, bookingStatus: 1 })
bookingSchema.index({ paymentReference: 1 }, { sparse: true })

const Booking = mongoose.model("Booking", bookingSchema)

module.exports = Booking