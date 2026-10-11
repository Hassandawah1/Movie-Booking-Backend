const mongoose = require("mongoose")

const screenSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Screen name is required"],
      unique: true,
      trim: true
    },

    screenType: {
      type: String,
      enum: ["standard", "vip"],
      default: "standard"
    },

    totalRows: {
      type: Number,
      required: [true, "Total rows is required"],
      min: [1, "Total rows must be at least 1"],
      max: [26, "Maximum 26 rows supported (A-Z)"]
    },

    seatsPerRow: {
      type: Number,
      required: [true, "Seats per row is required"],
      min: [1, "Seats per row must be at least 1"]
    },

    
    totalSeats: {
      type: Number
    },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active"
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


screenSchema.pre("save", function () {
  this.totalSeats = this.totalRows * this.seatsPerRow
})


screenSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate()
  const set = update.$set || update

  const rows = set.totalRows !== undefined ? set.totalRows : undefined
  const perRow = set.seatsPerRow !== undefined ? set.seatsPerRow : undefined

  
  
})

const Screen = mongoose.model("Screen", screenSchema)

module.exports = Screen