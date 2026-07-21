const mongoose = require('mongoose');

/**
 * TutoringArea/Room Model
 * 
 * Represents physical spaces in the tutoring center:
 * - Tutoring Area: wide room for 1-on-1 and small-group sessions
 * - Toddler Room: exclusive for playgroup sessions
 * 
 * Each area can host multiple concurrent sessions with different tutors
 */
const tutoringAreaSchema = new mongoose.Schema({
  // Name of the area/room
  name: {
    type: String,
    required: true,
    trim: true,
    description: 'e.g., "Main Tutoring Area", "Toddlers Room", "Table A", "Table B"'
  },

  // Type of area
  areaType: {
    type: String,
    enum: ['tutoring_area', 'toddler_room'],
    required: true,
    description: 'tutoring_area: for 1-on-1 and small-group; toddler_room: playgroup only'
  },

  // Capacity as reference (not actively enforced here)
  capacity: {
    type: Number,
    default: 1,
    description: 'Reference capacity; actual capacity set per session'
  },

  // Is this area currently active/available for scheduling
  isActive: {
    type: Boolean,
    default: true
  },

  // Description or notes
  description: {
    type: String,
    default: ''
  },

  // Location within facility
  location: {
    type: String,
    default: 'Main building',
    description: 'Physical location info'
  },

  // Admin notes
  adminNotes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Index for finding available areas by type
tutoringAreaSchema.index({ areaType: 1, isActive: 1 });

module.exports = mongoose.model('TutoringArea', tutoringAreaSchema);
