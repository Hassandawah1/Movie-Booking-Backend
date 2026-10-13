const mongoose = require("mongoose")
const axios = require("axios")
const Movie = require("../models/Movie.model")



const VALID_STATUSES = ["coming-soon", "now-showing", "ended"]


const rapidApiHeaders = () => ({
  "X-RapidAPI-Key": process.env.MOVIE_API_KEY,
  "X-RapidAPI-Host": process.env.MOVIE_API_BASE_URL
})


const apiBase = () => `https://${process.env.MOVIE_API_BASE_URL}`

const firstImageUrl = (value) => {
  if (typeof value === "string") return value.trim()
  if (!value || typeof value !== "object") return ""
  if (Array.isArray(value)) {
    return value.map(firstImageUrl).find(Boolean) || ""
  }

  for (const key of [
    "url", "src", "value", "image", "artwork", "verticalArtwork",
    "verticalArtworkUrl", "verticalDisplayArt", "verticalBackgroundArt",
    "storyArt", "interestingMoments", "placeholderImage", "boxArt",
    "poster", "posterImage", "poster_path", "backdrop", "backdropImage", "backdrop_path"
  ]) {
    const imageUrl = firstImageUrl(value[key])
    if (imageUrl) return imageUrl
  }

  return ""
}

const respondToProviderError = (res, operation, apiErr) => {
  const status = apiErr.response?.status
  const providerCode = apiErr.code || null
  console.error(`External API error (${operation}):`, {
    status: status || null,
    code: providerCode
  })

  let message = "Movie provider is temporarily unavailable. Please try again later."
  let code = "MOVIE_PROVIDER_UNAVAILABLE"

  if (status === 401 || status === 403) {
    message = "Movie provider rejected its API credentials or subscription. Check the RapidAPI key and API subscription."
    code = "MOVIE_PROVIDER_AUTH"
  } else if (status === 429) {
    message = "Movie provider request limit reached. Check the RapidAPI quota or try again later."
    code = "MOVIE_PROVIDER_RATE_LIMITED"
  } else if (status === 404) {
    message = "RapidAPI could not find the movie provider endpoint (HTTP 404). Verify the configured host and endpoint path."
  } else if (status === 400) {
    message = "RapidAPI rejected the movie search request (HTTP 400). Verify the endpoint's expected query parameters."
  } else if (status >= 500) {
    message = `Movie provider returned HTTP ${status}. Check its RapidAPI status and endpoint configuration.`
  } else if (status) {
    message = `Movie provider returned HTTP ${status}. Check the RapidAPI endpoint configuration.`
  } else if (!apiErr.response) {
    message = "Could not connect to the movie provider. Check the backend network connection and try again."
    code = "MOVIE_PROVIDER_CONNECTION"
  }

  return res.status(502).json({
    success: false,
    message,
    code,
    providerStatus: status || null
  })
}


const normalizeMovie = (raw) => {
  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : null
  const details = raw.details && typeof raw.details === "object" ? raw.details : null
  const artwork = raw.dpSpecialCases?.videoInDP?.artwork && typeof raw.dpSpecialCases.videoInDP.artwork === "object"
    ? raw.dpSpecialCases.videoInDP.artwork
    : null

  const movieData = {
    ...raw,
    ...(details || {}),
    ...(summary || {}),
    ...(artwork || {})
  }

  const genres = []
  if (Array.isArray(movieData.genres)) {
    movieData.genres.forEach((g) => {
      if (typeof g === "string") genres.push(g)
      else if (g && g.name) genres.push(g.name)
    })
  }

  let releaseDate = null
  if (movieData.releaseYear) releaseDate = new Date(`${movieData.releaseYear}-01-01`)
  else if (movieData.releaseDate) releaseDate = new Date(movieData.releaseDate)

  const rating = movieData.imdbRating || movieData.voteAverage || movieData.rating || null
  const externalMovieId =
    movieData.id ||
    movieData.titleId ||
    movieData.titleID ||
    movieData.entityId ||
    movieData.entityID ||
    movieData.videoId ||
    movieData.video_id ||
    movieData._id ||
    raw.entityId ||
    raw.entityID ||
    raw.titleId ||
    raw.titleID ||
    raw.id ||
    raw.videoId ||
    raw.video_id ||
    raw._id ||
    ""

  const rawRuntime = movieData.runtime || movieData.duration || raw.runtime || raw.duration
  const runtime = rawRuntime
    ? (Number(rawRuntime) > 300 ? Math.round(Number(rawRuntime) / 60) : Number(rawRuntime))
    : null

  const posterUrl =
    firstImageUrl(movieData.verticalArtworkUrl) ||
    firstImageUrl(movieData.verticalDisplayArt) ||
    firstImageUrl(movieData.verticalBackgroundArt) ||
    firstImageUrl(movieData.storyArt) ||
    firstImageUrl(movieData.boxArt) ||
    firstImageUrl(movieData.poster) ||
    firstImageUrl(movieData.posterImage) ||
    firstImageUrl(movieData.poster_path) ||
    firstImageUrl(raw.verticalArtworkUrl) ||
    firstImageUrl(raw.verticalDisplayArt) ||
    firstImageUrl(raw.verticalBackgroundArt) ||
    firstImageUrl(raw.storyArt) ||
    firstImageUrl(raw.boxArt) ||
    ""

  const backdropUrl =
    firstImageUrl(movieData.interestingMoments) ||
    firstImageUrl(movieData.storyArt) ||
    firstImageUrl(movieData.placeholderImage) ||
    firstImageUrl(movieData.backdrop) ||
    firstImageUrl(movieData.backdropImage) ||
    firstImageUrl(movieData.backdrop_path) ||
    firstImageUrl(raw.interestingMoments) ||
    firstImageUrl(raw.placeholderImage) ||
    posterUrl ||
    ""

  return {
    externalMovieId: String(externalMovieId),
    title: movieData.title || movieData.name || movieData.displayName || movieData.originalTitle || "",
    overview: movieData.synopsis || movieData.overview || movieData.description || "",
    posterUrl,
    backdropUrl,
    genres,
    runtime,
    releaseDate,
    rating: rating ? Number(rating) : null,
    language: movieData.language || movieData.originalLanguage || ""
  }
}

const extractMovieRecord = (data) => {
  if (!data || typeof data !== "object") return null

  // Fast-path: RapidAPI Netflix title details response: value.videos[titleId]
  if (data.value?.videos && typeof data.value.videos === "object") {
    const videoEntries = Object.entries(data.value.videos)
    if (videoEntries.length > 0) {
      const [videoId, vid] = videoEntries[0]
      if (vid && typeof vid === "object") {
        return {
          id: videoId,
          entityId: videoId,
          ...vid,
          ...(vid.details || {}),
          ...(vid.summary || {}),
          ...(vid.dpSpecialCases?.videoInDP?.artwork || {})
        }
      }
    }
  }

  const visited = new Set()
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const record = visit(item)
        if (record) return record
      }
      return null
    }
    if (!value || typeof value !== "object" || visited.has(value)) return null
    visited.add(value)

    if (value.summary && typeof value.summary === "object") {
      return { ...value, ...value.summary }
    }

    const normalized = normalizeMovie(value)
    if (typeof normalized.title === "string" && normalized.title.trim()) return value

    const prioritizedKeys = ["title", "result", "movie", "details", "summary", "value"]
    for (const key of prioritizedKeys) {
      if (value[key] && typeof value[key] === "object") {
        const record = visit(value[key])
        if (record) return record
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!prioritizedKeys.includes(key)) {
        const record = visit(child)
        if (record) return record
      }
    }
    return null
  }

  return visit(data)
}

const extractSearchResults = (data) => {
  if (Array.isArray(data)) return data
  if (!data || typeof data !== "object") return null
  if (Array.isArray(data.results)) return data.results
  if (Array.isArray(data.titles)) return data.titles

  const results = []
  const seen = new Set()
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") return

    if (value.summary && typeof value.summary === "object") {
      const record = { ...value, ...value.summary }
      const normalized = normalizeMovie(record)
      if (normalized.title && normalized.externalMovieId) {
        if (!seen.has(normalized.externalMovieId)) {
          seen.add(normalized.externalMovieId)
          results.push(record)
        }
        return
      }

      visit(record)
      Object.entries(value).forEach(([key, child]) => {
        if (key !== "summary") visit(child)
      })
      return
    }

    const id = value.entityId || value.entityID || value.titleId || value.titleID || value.id || value.videoId || value.video_id || value._id
    const title = value.title || value.name || value.displayName || value.originalTitle
    if (id && title) {
      const key = String(id)
      if (!seen.has(key)) {
        seen.add(key)
        results.push(value)
      }
      return
    }

    Object.values(value).forEach(visit)
  }

  visit(data)
  if (results.length > 0) return results

  const searchPage = data.value?.searchPageByReferenceV2
  if (searchPage && typeof searchPage === "object" && Object.keys(searchPage).length === 0) return []
  return null
}

const describeProviderShape = (value, depth = 0) => {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: depth < 6 ? value.slice(0, 2).map((item) => describeProviderShape(item, depth + 1)) : undefined
    }
  }
  if (!value || typeof value !== "object") return { type: value === null ? "null" : typeof value }

  const safeKeys = new Set([
    "value", "paths", "searchPageByReferenceV2", "summary", "entityId", "entityID",
    "entityKind", "title", "name", "displayName", "originalTitle", "id", "titleId",
    "titleID", "videoId", "video_id", "verticalArtworkUrl", "items", "results",
    "searchResults", "videos", "length", "0"
  ])
  const keys = Object.keys(value)
  const visibleKeys = keys.filter((key) => safeKeys.has(key))
  const otherKeys = keys.filter((key) => !safeKeys.has(key))
  return {
    type: "object",
    keys: visibleKeys,
    otherKeyCount: otherKeys.length,
    sample: depth < 6
      ? visibleKeys.slice(0, 8).reduce((shape, key) => {
          shape[key] = describeProviderShape(value[key], depth + 1)
          return shape
        }, {})
      : undefined,
    otherValueSamples: depth < 6
      ? otherKeys.slice(0, 2).map((key) => describeProviderShape(value[key], depth + 1))
      : undefined
  }
}






const searchMovies = async (req, res) => {
  try {
    const query = req.query.query ? req.query.query.trim() : ""

    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Search query is required"
      })
    }

    let response
    try {
      response = await axios.get(`${apiBase()}/api/search`, {
        params: { query },
        headers: rapidApiHeaders()
      })
    } catch (apiErr) {
      return respondToProviderError(res, "search", apiErr)
    }

    const rawResults = extractSearchResults(response.data)
    if (!rawResults) {
      console.error(
        "External API returned an unexpected search response shape:",
        JSON.stringify(describeProviderShape(response.data))
      )
      return res.status(502).json({
        success: false,
        message: "Movie provider returned an unexpected response. Verify the configured RapidAPI host and search endpoint.",
        code: "MOVIE_PROVIDER_INVALID_RESPONSE"
      })
    }

    const results = rawResults
      .map(normalizeMovie)
      .filter((movie) => movie.externalMovieId && movie.title)

    return res.status(200).json({
      success: true,
      count: results.length,
      results
    })
  } catch (err) {
    console.error("searchMovies error:", err)
    return res.status(500).json({
      success: false,
      message: "Server error while searching movies"
    })
  }
}






const getExternalMovieDetails = async (req, res) => {
  try {
    const { externalMovieId } = req.params

    if (!externalMovieId || !externalMovieId.trim()) {
      return res.status(400).json({
        success: false,
        message: "External movie ID is required"
      })
    }

    let response
    try {
      response = await axios.get(`${apiBase()}/api/title/details`, {
        params: { titleId: externalMovieId.trim() },
        headers: rapidApiHeaders()
      })
    } catch (apiErr) {
      return respondToProviderError(res, "details", apiErr)
    }

    const raw = extractMovieRecord(response.data)
    if (!raw) {
      return res.status(404).json({
        success: false,
        message: "Movie not found in external provider"
      })
    }

    const movie = normalizeMovie(raw)
    if (!movie.externalMovieId) movie.externalMovieId = externalMovieId.trim()

    return res.status(200).json({
      success: true,
      movie
    })
  } catch (err) {
    console.error("getExternalMovieDetails error:", err)
    return res.status(500).json({
      success: false,
      message: "Server error while fetching movie details"
    })
  }
}






const addMovieToCinema = async (req, res) => {
  try {
    const { externalMovieId, posterUrl, backdropUrl, overview, runtime } = req.body

    if (!externalMovieId || !String(externalMovieId).trim()) {
      return res.status(400).json({
        success: false,
        message: "externalMovieId is required"
      })
    }

    const cleanId = String(externalMovieId).trim()

    const existing = await Movie.findOne({ externalMovieId: cleanId })
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "This movie has already been added to the cinema"
      })
    }

    let response
    try {
      response = await axios.get(`${apiBase()}/api/title/details`, {
        params: { titleId: cleanId },
        headers: rapidApiHeaders()
      })
    } catch (apiErr) {
      return respondToProviderError(res, "add movie", apiErr)
    }

    const raw = extractMovieRecord(response.data)
    if (!raw) {
      return res.status(404).json({
        success: false,
        message: "Movie not found in external provider"
      })
    }

    const normalized = normalizeMovie(raw)

    if (!normalized.externalMovieId) {
      normalized.externalMovieId = cleanId
    }

    if (!normalized.posterUrl && posterUrl) {
      normalized.posterUrl = String(posterUrl).trim()
    }
    if (!normalized.backdropUrl && backdropUrl) {
      normalized.backdropUrl = String(backdropUrl).trim()
    }
    if (!normalized.runtime && runtime) {
      const num = Number(runtime)
      normalized.runtime = num > 300 ? Math.round(num / 60) : num
    }
    if (!normalized.overview && overview) {
      normalized.overview = String(overview).trim()
    }

    if (!normalized.title) {
      return res.status(502).json({
        success: false,
        message: "External provider returned incomplete movie data"
      })
    }

    
    const movie = new Movie({
      ...normalized,
      status: "coming-soon",
      createdBy: req.user._id
    })

    await movie.save()

    return res.status(201).json({
      success: true,
      message: "Movie added to cinema successfully",
      movie
    })
  } catch (err) {
    console.error("addMovieToCinema error:", err)
    return res.status(500).json({
      success: false,
      message: "Server error while adding movie"
    })
  }
}






const getAllMovies = async (req, res) => {
  try {
    const filter = {}

    if (req.query.status) {
      const status = req.query.status.trim()
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`
        })
      }
      filter.status = status
    }

    const movies = await Movie.find(filter).sort({ createdAt: -1 })

    return res.status(200).json({
      success: true,
      count: movies.length,
      movies
    })
  } catch (err) {
    console.error("getAllMovies error:", err)
    return res.status(500).json({
      success: false,
      message: "Server error while fetching movies"
    })
  }
}






const getMovieById = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid movie ID format"
      })
    }

    const movie = await Movie.findById(req.params.id)

    if (!movie) {
      return res.status(404).json({
        success: false,
        message: "Movie not found"
      })
    }

    return res.status(200).json({
      success: true,
      movie
    })
  } catch (err) {
    
    if (err.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid movie ID format"
      })
    }
    console.error("getMovieById error:", err)
    return res.status(500).json({
      success: false,
      message: "Server error while fetching movie"
    })
  }
}






const updateMovie = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid movie ID format" })
    }

    const { status, title, overview } = req.body

    
    if (status === undefined && title === undefined && overview === undefined) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one field to update: status, title, or overview"
      })
    }

    const updates = {}

    if (status !== undefined) {
      const trimmed = String(status).trim()
      if (!VALID_STATUSES.includes(trimmed)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`
        })
      }
      updates.status = trimmed
    }

    if (title !== undefined) {
      const trimmed = String(title).trim()
      if (!trimmed) {
        return res.status(400).json({ success: false, message: "Title cannot be empty" })
      }
      updates.title = trimmed
    }

    if (overview !== undefined) {
      updates.overview = String(overview)
    }

    const movie = await Movie.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    )

    if (!movie) {
      return res.status(404).json({
        success: false,
        message: "Movie not found"
      })
    }

    return res.status(200).json({
      success: true,
      message: "Movie updated successfully",
      movie
    })
  } catch (err) {
    console.error("updateMovie error:", err)
    return res.status(500).json({
      success: false,
      message: "Server error while updating movie"
    })
  }
}






const deleteMovie = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid movie ID format" })
    }

    const movie = await Movie.findByIdAndDelete(req.params.id)

    if (!movie) {
      return res.status(404).json({
        success: false,
        message: "Movie not found"
      })
    }

    return res.status(200).json({
      success: true,
      message: "Movie removed successfully"
    })
  } catch (err) {
    console.error("deleteMovie error:", err)
    return res.status(500).json({
      success: false,
      message: "Server error while deleting movie"
    })
  }
}



module.exports = {
  searchMovies,
  getExternalMovieDetails,
  addMovieToCinema,
  getAllMovies,
  getMovieById,
  updateMovie,
  deleteMovie
}
