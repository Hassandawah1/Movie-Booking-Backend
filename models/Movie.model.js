const mongoose = require("mongoose")

const movieSchema = new mongoose.Schema(
  {
    externalMovieId: {
      type: String,
      required: [true, "External movie ID is required"],
      unique: true,
      trim: true
    },

    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true
    },

    overview: {
      type: String,
      default: ""
    },

    posterUrl: {
      type: String,
      default: ""
    },

    backdropUrl: {
      type: String,
      default: ""
    },

    genres: {
      type: [String],
      default: []
    },

    runtime: {
      type: Number,
      default: null
    },

    releaseDate: {
      type: Date,
      default: null
    },

    rating: {
      type: Number,
      default: null
    },

    language: {
      type: String,
      default: ""
    },

    
    
    status: {
      type: String,
      enum: ["coming-soon", "now-showing", "ended"],
      default: "coming-soon"
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

const Movie = mongoose.model("Movie", movieSchema)

module.exports = Movie