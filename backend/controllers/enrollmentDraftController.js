const EnrollmentDraft = require('../models/EnrollmentDraft');
const crypto = require('crypto');

const createDraft = async (req, res) => {
  try {
    const parentId = req.user && req.user._id;
    if (!parentId) return res.status(401).json({ success: false, message: 'Not authorized' });

    const draft = await EnrollmentDraft.create({ parent: parentId, checkoutToken: crypto.randomBytes(16).toString('hex'), stepData: {} });
    res.status(201).json({ success: true, draftId: draft._id, checkoutToken: draft.checkoutToken });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateDraft = async (req, res) => {
  try {
    const { id } = req.params;
    const { stepData } = req.body;
    const draft = await EnrollmentDraft.findById(id);
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
    if (String(draft.parent) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not your draft' });

    draft.stepData = { ...draft.stepData, ...(stepData || {}) };
    // extend expiry by 30 days from now for active drafts
    draft.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await draft.save();
    res.status(200).json({ success: true, draft });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getDraft = async (req, res) => {
  try {
    const { id } = req.params;
    const draft = await EnrollmentDraft.findById(id).lean();
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found' });
    if (String(draft.parent) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not your draft' });
    res.status(200).json({ success: true, draft });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { createDraft, updateDraft, getDraft };
