const nodemailer = require("nodemailer")

let transporter
let configurationWarningLogged = false

const getTransporter = () => {
  if (transporter !== undefined) return transporter

  const user = process.env.EMAIL_USER
  const pass = process.env.EMAIL_PASSWORD
  if (!user || !pass) {
    transporter = null
    if (!configurationWarningLogged) {
      console.warn("Email configuration missing — email notifications disabled.")
      configurationWarningLogged = true
    }
    return transporter
  }

  if (process.env.EMAIL_HOST) {
    const port = Number.parseInt(process.env.EMAIL_PORT, 10) || 587
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port,
      secure: process.env.EMAIL_SECURE === "true",
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      auth: { user, pass }
    })
  } else {
    transporter = nodemailer.createTransport({
      service: "gmail",
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
      auth: { user, pass }
    })
  }

  return transporter
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
}[character]))

const formatDate = (date) => {
  if (!date) return "N/A"
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return String(date)
  return parsed.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  })
}

const formatTime = (time) => {
  if (!time) return "N/A"
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time))
  if (!match) return String(time)
  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]))
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

const formatNaira = (amount) => {
  const value = Number(amount)
  if (!Number.isFinite(value)) return "₦0"
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value)
}

const getSender = () => {
  const address = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_FROM || process.env.EMAIL_USER
  const name = process.env.EMAIL_FROM_NAME || "Movie Booking"
  return `"${name.replace(/["\r\n]/g, "")}" <${address}>`
}

const safeSmtpErrorDetails = (err, recipient) => {
  let message = String(err.message || "Unknown SMTP error")
  for (const secret of [process.env.EMAIL_PASSWORD, process.env.EMAIL_USER, recipient]) {
    if (secret) message = message.split(secret).join("[REDACTED]")
  }
  return {
    message,
    code: err.code || null,
    responseCode: err.responseCode || null,
    command: err.command || null
  }
}

const sendEmail = async ({ to, subject, text, html }) => {
  if (!to || !String(to).trim()) {
    console.warn("Email notification skipped because no recipient address is available.")
    return { success: false, error: "No recipient email address" }
  }
  if (!subject || !text || !html) {
    console.error("Email notification skipped because required message content is missing.")
    return { success: false, error: "Email subject, text, and HTML are required" }
  }

  const mailTransporter = getTransporter()
  if (!mailTransporter) {
    return { success: false, error: "Email configuration is missing" }
  }

  try {
    const info = await mailTransporter.sendMail({
      from: getSender(),
      to: String(to).trim(),
      subject: String(subject).replace(/[\r\n]/g, " ").trim(),
      text,
      html
    })
    if (Array.isArray(info.accepted) && info.accepted.length === 0) {
      console.warn("Email notification was rejected by the SMTP server")
      return { success: false, error: "SMTP server rejected the recipient" }
    }
    console.info("Email notification sent successfully", { messageId: info.messageId })
    return { success: true, messageId: info.messageId }
  } catch (err) {
    const diagnostics = safeSmtpErrorDetails(err, String(to).trim())
    console.error("Email notification failed", diagnostics)
    return { success: false, error: diagnostics.message }
  }
}

const emailLayout = (heading, body) => `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f4f6f8;color:#1e293b;font-family:Arial,Helvetica,sans-serif">
  <main style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e2e8f0">
    <header style="padding:24px;background:#1a1b1d;color:#fff">
      <h1 style="margin:0;font-size:22px">${escapeHtml(heading)}</h1>
    </header>
    <section style="padding:24px;line-height:1.6">${body}</section>
    <footer style="padding:18px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px">
      This is an automated message regarding your Movie Booking account or reservation.
    </footer>
  </main>
</body>
</html>`

const bookingDetails = (booking, showtimeOverride = null) => ({
  movie: booking.movie?.title || "Movie",
  date: formatDate(showtimeOverride?.showDate || booking.showtime?.showDate),
  time: formatTime(showtimeOverride?.startTime || booking.showtime?.startTime),
  screen: booking.screen?.name || "Cinema Screen",
  seats: Array.isArray(booking.seats) ? booking.seats.map((seat) => seat.seatNumber || seat).join(", ") : "N/A",
  reference: booking.bookingReference || "N/A",
  amount: formatNaira(booking.totalAmount),
  ticketCount: Array.isArray(booking.seats) ? booking.seats.length : 0,
  expiry: booking.expiresAt
    ? `${formatDate(booking.expiresAt)} at ${new Date(booking.expiresAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : "N/A"
})

const detailRows = (details) => [
  ["Movie", details.movie],
  ["Date", details.date],
  ["Time", details.time],
  ["Screen", details.screen],
  ["Seats", details.seats],
  ["Booking Reference", details.reference],
  ["Tickets", details.ticketCount],
  ["Amount", details.amount]
].map(([label, value]) => `<tr><td style="padding:8px 0;color:#64748b">${escapeHtml(label)}</td><td style="padding:8px 0;text-align:right;font-weight:600">${escapeHtml(value)}</td></tr>`).join("")

const detailsTable = (details) => `<table style="width:100%;border-collapse:collapse;margin:20px 0">${detailRows(details)}</table>`

const sendWelcomeEmail = async (user) => {
  const name = user?.name || "Valued Customer"
  const safeName = escapeHtml(name)
  const text = `Hello ${name},\n\nWelcome to Movie Booking. Your account has been created successfully. You can browse movies, choose showtimes, book tickets, and manage your reservations.\n\nThank you for joining us.`
  const html = emailLayout("Welcome to Movie Booking", `<p>Hello ${safeName},</p><p>Your account has been created successfully. You can now browse movies, choose showtimes, book tickets, and manage your reservations.</p><p>Thank you for joining us.</p>`)
  return sendEmail({ to: user?.email, subject: "Welcome to Movie Booking", text, html })
}

const sendReservationEmail = async (booking) => {
  const details = bookingDetails(booking)
  const name = booking.user?.name || "Valued Customer"
  const text = `Hello ${name},\n\nYour seats are reserved while you complete payment.\n\nMovie: ${details.movie}\nDate: ${details.date}\nTime: ${details.time}\nScreen: ${details.screen}\nSeats: ${details.seats}\nBooking Reference: ${details.reference}\nTotal: ${details.amount}\nReservation expiry: ${details.expiry}\n\nYour booking is not confirmed until payment is completed.`
  const html = emailLayout("Seats Reserved — Complete Your Payment", `<p>Hello ${escapeHtml(name)},</p><p>Your seats are reserved while you complete payment.</p>${detailsTable(details)}<p><strong>Reservation expiry:</strong> ${escapeHtml(details.expiry)}</p><p style="padding:12px;background:#fff7ed;border:1px solid #fed7aa"><strong>Your booking is not confirmed until payment is completed.</strong></p>`)
  return sendEmail({ to: booking.user?.email, subject: "Seats Reserved — Complete Your Payment", text, html })
}

const sendBookingConfirmationEmail = async (booking, recipient = null) => {
  if (booking?.paymentStatus !== "paid" || booking?.bookingStatus !== "confirmed") {
    return { success: false, error: "Booking must be paid and confirmed before confirmation email is sent" }
  }
  const details = bookingDetails(booking)
  const user = recipient || booking.user
  const name = user?.name || "Valued Customer"
  const text = `Hello ${name},\n\nYour payment was successful and your booking is confirmed.\n\nMovie: ${details.movie}\nDate: ${details.date}\nTime: ${details.time}\nScreen: ${details.screen}\nSeats: ${details.seats}\nNumber of tickets: ${details.ticketCount}\nAmount Paid: ${details.amount}\nBooking Reference: ${details.reference}\nPayment Status: ${booking.paymentStatus}\nBooking Status: ${booking.bookingStatus}\n\nPlease keep your booking reference for entry/check-in.`
  const html = emailLayout("Booking Confirmed", `<p>Hello ${escapeHtml(name)},</p><p>Your payment was successful and your booking is confirmed.</p>${detailsTable(details)}<p><strong>Payment Status:</strong> ${escapeHtml(booking.paymentStatus)}<br><strong>Booking Status:</strong> ${escapeHtml(booking.bookingStatus)}</p><p>Please keep your booking reference for entry/check-in.</p>`)
  return sendEmail({ to: user?.email, subject: `Booking Confirmed — ${details.movie}`, text, html })
}

const sendCancellationEmail = async (booking, recipient = null) => {
  const details = bookingDetails(booking)
  const user = recipient || booking.user
  const name = user?.name || "Valued Customer"
  const text = `Hello ${name},\n\nYour reservation has been cancelled and the seats have been released.\n\nMovie: ${details.movie}\nDate: ${details.date}\nTime: ${details.time}\nSeats: ${details.seats}\nBooking Reference: ${details.reference}\n\nNo refund has been issued.`
  const html = emailLayout("Booking Cancelled", `<p>Hello ${escapeHtml(name)},</p><p>Your reservation has been cancelled and the seats have been released.</p>${detailsTable(details)}<p>No refund has been issued.</p>`)
  return sendEmail({ to: user?.email, subject: `Booking Cancelled — ${details.reference}`, text, html })
}

const sendShowtimeCancellationEmail = async (booking, originalShowtime = null) => {
  const details = bookingDetails(booking, originalShowtime)
  const isPaid = booking.paymentStatus === "paid"
  const name = booking.user?.name || "Valued Customer"
  const nextSteps = isPaid
    ? "Please contact support or the cinema administration regarding the next steps for your paid booking. No refund is confirmed by this notification."
    : "Your unpaid reservation is for a cancelled showtime and cannot be used. Please contact cinema administration if you need assistance."
  const text = `Hello ${name},\n\nThe scheduled showtime has been cancelled.\n\nMovie: ${details.movie}\nOriginal date: ${details.date}\nOriginal time: ${details.time}\nScreen: ${details.screen}\nBooking Reference: ${details.reference}\nSeats: ${details.seats}\n\n${nextSteps}`
  const html = emailLayout("Showtime Cancelled", `<p>Hello ${escapeHtml(name)},</p><p><strong>The scheduled showtime has been cancelled.</strong></p>${detailsTable(details)}<p>${escapeHtml(nextSteps)}</p>`)
  return sendEmail({ to: booking.user?.email, subject: `Showtime Cancelled — ${details.movie}`, text, html })
}

const sendRoleChangedEmail = async (user, newRole) => {
  const name = user?.name || "Valued Customer"
  const accessMessage = newRole === "admin"
    ? "Your account has been granted administrator access."
    : "Administrator access has been removed from your account."
  const text = `Hello ${name},\n\n${accessMessage}\n\nIf you did not expect this change, please contact the cinema administration.`
  const html = emailLayout("Your Account Role Has Changed", `<p>Hello ${escapeHtml(name)},</p><p>${escapeHtml(accessMessage)}</p><p>If you did not expect this change, please contact the cinema administration.</p>`)
  return sendEmail({ to: user?.email, subject: "Your Account Role Has Changed", text, html })
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendReservationEmail,
  sendBookingConfirmationEmail,
  sendCancellationEmail,
  sendShowtimeCancellationEmail,
  sendRoleChangedEmail
}
