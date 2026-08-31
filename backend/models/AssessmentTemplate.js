const mongoose = require('mongoose');

const ratingOptionSchema = new mongoose.Schema({
  value: { type: String, required: true },
  label: { type: String, required: true },
}, { _id: false });

const fieldSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  type: { type: String, default: 'text' },
}, { _id: false });

const itemSchema = new mongoose.Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
}, { _id: false });

const sectionSchema = new mongoose.Schema({
  key: { type: String, required: true },
  title: { type: String, required: true },
  items: [itemSchema],
}, { _id: false });

const assessmentTemplateSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  /** Programs this pre-enrollment assessment applies to (e.g. Academic Tutorial). */
  programCodes: [{ type: String, required: true }],
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  ratingScale: [ratingOptionSchema],
  infoFields: [fieldSchema],
  sections: [sectionSchema],
  remarksEnabled: { type: Boolean, default: true },
  remarksLabel: { type: String, default: 'Additional Assessment Remarks and Observations' },
  goalsCount: { type: Number, default: 8 },
  goalsTitle: { type: String, default: 'Learning Goals and Proposed Timeline' },
  goalColumnLabel: { type: String, default: 'Learning Goals' },
  timelineColumnLabel: { type: String, default: 'Proposed Timeline' },
  assessedByLabel: { type: String, default: 'Assessed by' },
  notApplicableLabel: {
    type: String,
    default: 'This assessment does not apply (child is not in a listed level).',
  },
}, { timestamps: true });

module.exports = mongoose.model('AssessmentTemplate', assessmentTemplateSchema);
