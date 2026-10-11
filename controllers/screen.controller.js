const mongoose = require("mongoose")
const Screen = require("../models/Screen.model")
const Showtime = require("../models/Showtime.model")

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_SCREEN_TYPES = ["standard", "vip"]
const VALID_SCREEN_STATUSES = ["active", "inactive"]

// ─── Create Screen ────────────────────────────────────────────────────────────

// @desc    Create a new cinema screen/hall
// @route   POST /api/screens
// @access  Admin
const createScreen = async (req, res) => {
  try {
    const { name, screenType, totalRows, seatsPerRow } = req.body

    // ── Validation ──
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "Screen name is required" })
    }

    if (totalRows === undefined || totalRows === null || totalRows === "") {
      return res.status(400).json({ success: false, message: "totalRows is required" })
    }

    if (seatsPerRow === undefined || seatsPerRow === null || seatsPerRow === "") {
      return res.status(400).json({ success: false, message: "seatsPerRow is required" })
    }

    const rows = Number(totalRows)
    const perRow = Number(seatsPerRow)

    if (isNaN(rows) || !Number.isInteger(rows) || rows < 1 || rows > 26) {
      return res.status(400).json({ success: false, message: "totalRows must be a whole number between 1 and 26" })
    }

    if (isNaN(perRow) || !Number.isInteger(perRow) || perRow < 1) {
      return res.status(400).json({ success: false, message: "seatsPerRow must be a whole number of at least 1" })
    }

    if (screenType && !VALID_SCREEN_TYPES.includes(screenType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid screenType. Must be one of: ${VALID_SCREEN_TYPES.join(", ")}`
      })
    }

    // ── Duplicate name check ──
    const existing = await Screen.findOne({ name: String(name).trim() })
    if (existing) {
      return res.status(409).json({ success: false, message: "A screen with this name already exists" })
    }

    // ── Create — totalSeats is calculated by the pre-save hook ──
    const screen = new Screen({
      name: String(name).trim(),
      screenType: screenType || "standard",
      totalRows: rows,
      seatsPerRow: perRow,
      createdBy: req.user._id
    })

    await screen.save()

    return res.status(201).json({
      success: true,
      message: "Screen created successfully",
      screen: {
        id: screen._id,
        name: screen.name,
        screenType: screen.screenType,
        totalRows: screen.totalRows,
        seatsPerRow: screen.seatsPerRow,
        totalSeats: screen.totalSeats,
        status: screen.status
      }
    })
  } catch (err) {
    console.error("createScreen error:", err)
    return res.status(500).json({ success: false, message: "Server error while creating screen" })
  }
}

// ─── Get All Screens ──────────────────────────────────────────────────────────

// @desc    List all cinema screens
// @route   GET /api/screens
// @access  Admin
const getAllScreens = async (req, res) => {
  try {
    const screens = await Screen.find().sort({ createdAt: -1 })

    return res.status(200).json({
      success: true,
      count: screens.length,
      screens
    })
  } catch (err) {
    console.error("getAllScreens error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching screens" })
  }
}

// ─── Get Single Screen ────────────────────────────────────────────────────────

// @desc    Get a single screen by ID
// @route   GET /api/screens/:id
// @access  Admin
const getScreenById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid screen ID format" })
    }

    const screen = await Screen.findById(req.params.id)
    if (!screen) {
      return res.status(404).json({ success: false, message: "Screen not found" })
    }

    return res.status(200).json({ success: true, screen })
  } catch (err) {
    console.error("getScreenById error:", err)
    return res.status(500).json({ success: false, message: "Server error while fetching screen" })
  }
}

// ─── Update Screen ────────────────────────────────────────────────────────────

// @desc    Update screen details
// @route   PUT /api/screens/:id
// @access  Admin
const updateScreen = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid screen ID format" })
    }

    const { name, screenType, totalRows, seatsPerRow, status } = req.body

    // At least one field required
    if (
      name === undefined &&
      screenType === undefined &&
      totalRows === undefined &&
      seatsPerRow === undefined &&
      status === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one field to update: name, screenType, totalRows, seatsPerRow, status"
      })
    }

    // Fetch current screen so we can safely recalculate totalSeats
    const screen = await Screen.findById(req.params.id)
    if (!screen) {
      return res.status(404).json({ success: false, message: "Screen not found" })
    }

    // ── Validate and apply each field ──
    if (name !== undefined) {
      const trimmed = String(name).trim()
      if (!trimmed) return res.status(400).json({ success: false, message: "Screen name cannot be empty" })
      // Check for duplicate name (excluding current screen)
      const dup = await Screen.findOne({ name: trimmed, _id: { $ne: req.params.id } })
      if (dup) return res.status(409).json({ success: false, message: "A screen with this name already exists" })
      screen.name = trimmed
    }

    if (screenType !== undefined) {
      if (!VALID_SCREEN_TYPES.includes(screenType)) {
        return res.status(400).json({
          success: false,
          message: `Invalid screenType. Must be one of: ${VALID_SCREEN_TYPES.join(", ")}`
        })
      }
      screen.screenType = screenType
    }

    if (totalRows !== undefined) {
      const rows = Number(totalRows)
      if (isNaN(rows) || !Number.isInteger(rows) || rows < 1 || rows > 26) {
        return res.status(400).json({ success: false, message: "totalRows must be a whole number between 1 and 26" })
      }
      screen.totalRows = rows
    }

    if (seatsPerRow !== undefined) {
      const perRow = Number(seatsPerRow)
      if (isNaN(perRow) || !Number.isInteger(perRow) || perRow < 1) {
        return res.status(400).json({ success: false, message: "seatsPerRow must be a whole number of at least 1" })
      }
      screen.seatsPerRow = perRow
    }

    if (status !== undefined) {
      if (!VALID_SCREEN_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_SCREEN_STATUSES.join(", ")}`
        })
      }
      screen.status = status
    }

    // Recalculate totalSeats (pre-save hook also does this, but explicit is clear)
    screen.totalSeats = screen.totalRows * screen.seatsPerRow

    await screen.save()

    return res.status(200).json({
      success: true,
      message: "Screen updated successfully",
      screen
    })
  } catch (err) {
    console.error("updateScreen error:", err)
    return res.status(500).json({ success: false, message: "Server error while updating screen" })
  }
}

// ─── Delete Screen ────────────────────────────────────────────────────────────

// @desc    Delete a screen — blocked if future active showtimes exist
// @route   DELETE /api/screens/:id
// @access  Admin
const deleteScreen = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid screen ID format" })
    }

    const screen = await Screen.findById(req.params.id)
    if (!screen) {
      return res.status(404).json({ success: false, message: "Screen not found" })
    }

    // Check for future scheduled showtimes using this screen
    const now = new Date()
    const activeShowtimes = await Showtime.countDocuments({
      screen: req.params.id,
      status: "scheduled",
      showDate: { $gte: now }
    })

    if (activeShowtimes > 0) {
      return res.status(409).json({
        success: false,
        message: "Screen cannot be deleted because it has active upcoming showtimes"
      })
    }

    await Screen.findByIdAndDelete(req.params.id)

    return res.status(200).json({
      success: true,
      message: "Screen deleted successfully"
    })
  } catch (err) {
    console.error("deleteScreen error:", err)
    return res.status(500).json({ success: false, message: "Server error while deleting screen" })
  }
}

module.exports = {
  createScreen,
  getAllScreens,
  getScreenById,
  updateScreen,
  deleteScreen
}
