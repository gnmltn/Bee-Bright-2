const Pricing = require('../models/Pricing');
const { logAudit } = require('../utils/auditService');

const getAllPricing = async (req, res) => {
  try {
    const pricing = await Pricing.find({ active: true }).sort({ programCode: 1, packageSlug: 1 }).lean();
    res.status(200).json({ success: true, count: pricing.length, pricing });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const createOrUpdatePricing = async (req, res) => {
  try {
    const data = req.body;
    if (!data.programCode || !data.packageSlug || data.priceFull == null) {
      return res.status(400).json({ success: false, message: 'programCode, packageSlug and priceFull are required' });
    }

    const filter = { programCode: data.programCode, packageSlug: data.packageSlug };
    const update = {
      ...data,
      active: typeof data.active === 'boolean' ? data.active : true
    };

    const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
    const doc = await Pricing.findOneAndUpdate(filter, update, opts);

    logAudit({ req, userId: req.user?.id, action: 'Upsert Pricing', module: 'Pricing', description: `Upserted pricing ${doc.programCode}/${doc.packageSlug}` }).catch(() => {});

    res.status(200).json({ success: true, pricing: doc });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { getAllPricing, createOrUpdatePricing };
