/**
 * Retire legacy/removed pricing packages from the database.
 * Called once on server startup via ensureRetiredPricing().
 * Safe to call repeatedly — uses updateMany which is idempotent.
 */
const Pricing = require('../models/Pricing');

const RETIRED_CODES = ['PKR105', 'KRP104', 'SPT103', 'EXAM'];

const RETIRED_ACT102_SLUGS = [
  // Old flat slugs from the original pricing-seed.json import (before the new slug naming)
  'premier', 'premier_alt', 'premier_12',
  'elite', 'elite_alt',
  'prestige', 'prestige_alt',
  'royalty', 'royalty_alt',
  // NOTE: premier-elementary and premier-highschool are ACTIVE packages per brochure
];

async function ensureRetiredPricing() {
  try {
    const r1 = await Pricing.updateMany(
      { programCode: { $in: RETIRED_CODES } },
      { $set: { active: false } }
    );

    const r2 = await Pricing.updateMany(
      { programCode: 'ACT102', packageSlug: { $in: RETIRED_ACT102_SLUGS } },
      { $set: { active: false } }
    );

    const totalRetired = r1.modifiedCount + r2.modifiedCount;
    if (totalRetired > 0) {
      console.log(`✅ Retired ${totalRetired} legacy pricing record(s) on startup.`);
    }
  } catch (err) {
    console.warn('⚠️ retireLegacyPricing: could not retire records:', err.message);
  }
}

module.exports = { ensureRetiredPricing };
