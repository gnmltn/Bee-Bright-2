const mongoose = require('mongoose');

// Daily sequence counter for generating BB-YYYYMMDD-XXXX enrollment IDs atomically
const enrollmentCounterSchema = new mongoose.Schema({
  _id: { type: String }, // YYYYMMDD date key
  seq: { type: Number, default: 0 }
}, { timestamps: false });

module.exports = mongoose.models.EnrollmentCounter ||
  mongoose.model('EnrollmentCounter', enrollmentCounterSchema);
