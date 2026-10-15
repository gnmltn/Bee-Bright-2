const mongoose = require('mongoose');

// Backs middleware/rateLimit.js's counters in MongoDB (the one shared datastore this
// app already connects to) instead of an in-process Map, so counts are correct across
// a restart and would stay correct if this ever ran as more than one process.
// `resetAt` doubles as a TTL index: once a window's cutoff passes, Mongo's background
// TTL monitor deletes the document on its own if that key is never hit again — no
// manual sweep needed, closing the unbounded-growth gap the old Map had.
const rateLimitAttemptSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // `${limiterType}:${ip}`
  count: { type: Number, required: true, default: 0 },
  resetAt: { type: Date, required: true, expires: 0 },
}, { timestamps: false });

module.exports = mongoose.models.RateLimitAttempt ||
  mongoose.model('RateLimitAttempt', rateLimitAttemptSchema);
