const mongoose = require('mongoose');

const systemSettingsSchema = new mongoose.Schema({
  maintenanceMode: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

// Single document for app-wide settings (use findOneAndUpdate with upsert)
module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
