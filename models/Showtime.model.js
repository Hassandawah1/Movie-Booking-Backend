const mongoose = require("mongoose")

const showtimeSchema = new mongoose.Schema(
  {
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

    
    showDate: {
      type: Date,
      required: [true, "Show date is required"]
    },

    
    startTime: {
      type: String,
      required: [true, "Start time is required"],
      trim: true
    },

    
    endTime: {
      type: String,
      default: null
    },

    
    standardPrice: {
      type: Number,
      required: [true, "Standard price is required"],
      min: [0, "Standard price cannot be negative"]
    },

    vipPrice: {
      type: Number,
      default: null,
      min: [0, "VIP price cannot be negative"]
    },

    
    
    bookedSeats: {
      type: [String],
      default: []
    },

    status: {
      type: String,
      enum: ["scheduled", "cancelled", "completed"],
      default: "scheduled"
    },

    
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    }
  },
  {
    timestamps: true
  }
)

showtimeSchema.index({ movie: 1, showDate: 1, status: 1 })
showtimeSchema.index({ screen: 1, showDate: 1, status: 1 })

const Showtime = mongoose.model("Showtime", showtimeSchema)

module.exports = Showtime