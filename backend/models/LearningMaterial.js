const mongoose = require('mongoose');

/**
 * Learning materials (PDF, video, web link, image, etc.) uploaded by tutors.
 * Files are stored on disk (uploads/materials); MongoDB stores metadata and path/URL.
 * assignedStudents limits visibility to selected students only.
 */
const learningMaterialSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters'],
  },
  description: {
    type: String,
    default: '',
    trim: true,
    maxlength: [2000, 'Description cannot exceed 2000 characters'],
  },
  /** Type of material: pdf, video, web_link, image, document, other */
  materialType: {
    type: String,
    required: [true, 'Material type is required'],
    enum: ['pdf', 'video', 'web_link', 'image', 'document', 'other'],
  },
  /** Category for organization: Lecture Notes, Video Lecture, Practice, Reference, etc. */
  category: {
    type: String,
    required: [true, 'Category is required'],
    trim: true,
    maxlength: [100, 'Category cannot exceed 100 characters'],
  },
  /** Either file (stored on server) or external URL */
  storageType: {
    type: String,
    required: true,
    enum: ['file', 'url'],
  },
  /** Relative path under uploads/ (e.g. materials/abc123.pdf) when storageType is 'file' */
  filePath: {
    type: String,
    default: null,
    trim: true,
  },
  /** Original filename for display/download */
  fileName: {
    type: String,
    default: null,
    trim: true,
  },
  /** External URL when storageType is 'url' (e.g. web links, YouTube, etc.) */
  url: {
    type: String,
    default: null,
    trim: true,
    maxlength: [2000, 'URL cannot exceed 2000 characters'],
  },
  /** Tutor who uploaded */
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  /** Students who can see this material (empty = no one; must be explicit) */
  assignedStudents: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  /** Optional high-level program/subject this material relates to (e.g. Academic Tutorial) */
  subject: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subject',
    default: null,
  },
  /** Optional program category label (matches Grade.programCategory / PROGRAM_CATEGORIES.label) */
  programCategory: {
    type: String,
    trim: true,
    maxlength: [120, 'Program category too long for material'],
    default: '',
  },
  /** Optional subject/topic within the program (matches Grade.subjectItem) */
  subjectItem: {
    type: String,
    trim: true,
    maxlength: [120, 'Subject item too long for material'],
    default: '',
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

learningMaterialSchema.index({ uploadedBy: 1, createdAt: -1 });
learningMaterialSchema.index({ assignedStudents: 1 });
learningMaterialSchema.index({ category: 1 });
learningMaterialSchema.index({ programCategory: 1, subjectItem: 1 });

const LearningMaterial = mongoose.models.LearningMaterial || mongoose.model('LearningMaterial', learningMaterialSchema);
module.exports = LearningMaterial;
