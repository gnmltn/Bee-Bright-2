const mongoose = require('mongoose');

/**
 * A conversation flagged for a human to follow up on.
 *
 * source 'child_safety'  → a student message tripped the safety screen (Task 3)
 * source 'handoff'       → the assistant could not help / user asked for a person (Task 4)
 *
 * Never stores a full transcript — only a capped snippet of the triggering message.
 */
const escalationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  userIdentifier: { type: String, default: null }, // anon/session marker when no user
  role: { type: String, default: null },

  source: {
    type: String,
    enum: ['child_safety', 'handoff'],
    required: true,
  },
  category: {
    type: String,
    // child_safety: self_harm | abuse | bullying
    // handoff:      human_requested | repeated_no_match | billing_dispute | complaint | other
    required: true,
  },
  trigger: { type: String, default: '' },              // short human-readable reason
  severity: {
    type: String,
    enum: ['urgent', 'normal'],
    default: 'normal',
  },
  conversationSnippet: { type: String, default: '' },   // capped; never the full transcript

  status: {
    type: String,
    enum: ['open', 'acknowledged', 'resolved'],
    default: 'open',
  },
  handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  handledAt: { type: Date, default: null },
  resolutionNote: { type: String, default: '' },

  ipAddress: { type: String, default: null },
  userAgent: { type: String, default: null },
}, { timestamps: true });

escalationSchema.index({ status: 1, severity: 1, createdAt: -1 });
escalationSchema.index({ user: 1, createdAt: -1 });
escalationSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.models.Escalation || mongoose.model('Escalation', escalationSchema);
