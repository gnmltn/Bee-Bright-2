/**
 * Seed Pricing collection — Bee Bright Tutorial Center
 *
 * PROGRAMS (3 only, from brochure):
 *   TPG101 – Toddlers Playgroup       (age 1.5 – 3)
 *   ACT102 – Academic Tutorial        (age 2+, 1-on-1)
 *   EXP106 – Examination Preparation  (age 3+)
 *
 * REMOVED: PKR105, KRP104, SPT103 — not listed in current brochure rates.
 *
 * PAYMENT: 50% down payment only. priceDown = Math.ceil(priceFull * 0.5)
 *
 * Run: node backend/scripts/seed-pricing.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Pricing = require('../models/Pricing');

const MONGO =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGO ||
  'mongodb://127.0.0.1:27017/beebright';

// Codes that are NO LONGER offered — mark inactive so they stop appearing
const RETIRED_CODES = ['PKR105', 'KRP104', 'SPT103', 'EXAM'];

// ── Active pricing from brochure ──────────────────────────────────────────────
const PRICING = [
  // ══════════════════════════════════════════════════════════════════════
  //  TODDLERS PLAYGROUP
  //  Age: 1.5 – 3 years old | Group sessions (2 hrs each)
  // ══════════════════════════════════════════════════════════════════════
  {
    programCode: 'TPG101',
    packageSlug: '16h',
    displayName: 'Toddlers Playgroup – 16 Hours',
    durationDesc: '16 hours (8 sessions / 2× per week)',
    sessionCount: 8,
    priceFull: 2800,
    currency: 'PHP',
    displayOrder: 1,
    ageMin: 1.5,
    ageMax: 3,
    active: true,
  },
  {
    programCode: 'TPG101',
    packageSlug: '24h',
    displayName: 'Toddlers Playgroup – 24 Hours',
    durationDesc: '24 hours (12 sessions / 3× per week)',
    sessionCount: 12,
    priceFull: 4080,
    currency: 'PHP',
    displayOrder: 2,
    ageMin: 1.5,
    ageMax: 3,
    active: true,
  },
  {
    programCode: 'TPG101',
    packageSlug: '32h',
    displayName: 'Toddlers Playgroup – 32 Hours',
    durationDesc: '32 hours (16 sessions / 4× per week)',
    sessionCount: 16,
    priceFull: 5280,
    currency: 'PHP',
    displayOrder: 3,
    ageMin: 1.5,
    ageMax: 3,
    active: true,
  },
  {
    programCode: 'TPG101',
    packageSlug: '40h',
    displayName: 'Toddlers Playgroup – 40 Hours',
    durationDesc: '40 hours (20 sessions / 5× per week)',
    sessionCount: 20,
    priceFull: 6400,
    currency: 'PHP',
    displayOrder: 4,
    ageMin: 1.5,
    ageMax: 3,
    active: true,
  },

  // ══════════════════════════════════════════════════════════════════════
  //  ACADEMIC TUTORIAL
  //  Age: 2+ | 1-on-1 sessions (2 hrs each)
  //  Brochure packages: Premier, Elite, Prestige, Royalty
  //  Each has two price tiers: Pre-School/Elementary and Junior/Senior High School
  // ══════════════════════════════════════════════════════════════════════
  {
    programCode: 'ACT102',
    packageSlug: 'premier-elementary',
    displayName: 'Academic Tutorial – Premier (Pre-School / Elementary)',
    durationDesc: '12 sessions (3× per week)',
    sessionCount: 12,
    priceFull: 2400,
    currency: 'PHP',
    displayOrder: 1,
    ageMin: 2,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'ACT102',
    packageSlug: 'premier-highschool',
    displayName: 'Academic Tutorial – Premier (Junior / Senior High School)',
    durationDesc: '12 sessions (3× per week)',
    sessionCount: 12,
    priceFull: 2600,
    currency: 'PHP',
    displayOrder: 2,
    ageMin: 2,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'ACT102',
    packageSlug: 'elite-elementary',
    displayName: 'Academic Tutorial – Elite (Pre-School / Elementary)',
    durationDesc: '20 sessions (5× per week)',
    sessionCount: 20,
    priceFull: 3800,
    currency: 'PHP',
    displayOrder: 3,
    ageMin: 2,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'ACT102',
    packageSlug: 'elite-highschool',
    displayName: 'Academic Tutorial – Elite (Junior / Senior High School)',
    durationDesc: '20 sessions (5× per week)',
    sessionCount: 20,
    priceFull: 4000,
    currency: 'PHP',
    displayOrder: 4,
    ageMin: 2,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'ACT102',
    packageSlug: 'prestige-elementary',
    displayName: 'Academic Tutorial – Prestige (Pre-School / Elementary)',
    durationDesc: '16 sessions (4× per week)',
    sessionCount: 16,
    priceFull: 3120,
    currency: 'PHP',
    displayOrder: 5,
    ageMin: 2,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'ACT102',
    packageSlug: 'prestige-highschool',
    displayName: 'Academic Tutorial – Prestige (Junior / Senior High School)',
    durationDesc: '16 sessions (4× per week)',
    sessionCount: 16,
    priceFull: 3320,
    currency: 'PHP',
    displayOrder: 6,
    ageMin: 2,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'ACT102',
    packageSlug: 'royalty-elementary',
    displayName: 'Academic Tutorial – Royalty (Pre-School / Elementary)',
    durationDesc: '60 sessions / 3 months',
    sessionCount: 60,
    priceFull: 11000,
    currency: 'PHP',
    displayOrder: 7,
    ageMin: 2,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'ACT102',
    packageSlug: 'royalty-highschool',
    displayName: 'Academic Tutorial – Royalty (Junior / Senior High School)',
    durationDesc: '60 sessions / 3 months',
    sessionCount: 60,
    priceFull: 11200,
    currency: 'PHP',
    displayOrder: 8,
    ageMin: 2,
    ageMax: null,
    active: true,
  },

  // ══════════════════════════════════════════════════════════════════════
  //  EXAMINATION PREPARATION
  //  Age: 3+ years old (min 3, from pre-school to high school) | 1-on-1 sessions
  // ══════════════════════════════════════════════════════════════════════
  {
    programCode: 'EXP106',
    packageSlug: 'bright',
    displayName: 'Exam Prep – Bright Package',
    durationDesc: '5 sessions',
    sessionCount: 5,
    priceFull: 1250,
    currency: 'PHP',
    displayOrder: 1,
    ageMin: 3,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'EXP106',
    packageSlug: 'smart',
    displayName: 'Exam Prep – Smart Package',
    durationDesc: '6 sessions',
    sessionCount: 6,
    priceFull: 1450,
    currency: 'PHP',
    displayOrder: 2,
    ageMin: 3,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'EXP106',
    packageSlug: 'brilliant',
    displayName: 'Exam Prep – Brilliant Package',
    durationDesc: '8 sessions',
    sessionCount: 8,
    priceFull: 1850,
    currency: 'PHP',
    displayOrder: 3,
    ageMin: 3,
    ageMax: null,
    active: true,
  },
  {
    programCode: 'EXP106',
    packageSlug: 'genius',
    displayName: 'Exam Prep – Genius Package',
    durationDesc: '10 sessions',
    sessionCount: 10,
    priceFull: 2200,
    currency: 'PHP',
    displayOrder: 4,
    ageMin: 3,
    ageMax: null,
    active: true,
  },
];

async function run() {
  try {
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('✅ Connected to MongoDB:', MONGO);

    // ── Mark retired programs inactive so they stop showing in the UI ──
    const retiredResult = await Pricing.updateMany(
      { programCode: { $in: RETIRED_CODES } },
      { $set: { active: false } }
    );
    console.log(`\n🗄  Retired ${retiredResult.modifiedCount} old package(s): ${RETIRED_CODES.join(', ')}`);

    // ── Also mark old ACT102 slugs that no longer exist in brochure ──
    const retiredSlugs = [
      // Old flat slugs from the original pricing-seed.json import (before the new slug naming)
      'premier', 'premier_alt', 'elite', 'elite_alt',
      'prestige', 'prestige_alt', 'royalty', 'royalty_alt',
    ];
    const retiredAct = await Pricing.updateMany(
      { programCode: 'ACT102', packageSlug: { $in: retiredSlugs } },
      { $set: { active: false } }
    );
    console.log(`🗄  Retired ${retiredAct.modifiedCount} old ACT102 package(s).`);

    // ── Upsert active packages ──
    console.log('\n📦 Upserting active packages…');
    let upserted = 0;
    for (const p of PRICING) {
      const priceDown = Math.ceil(p.priceFull * 0.5);
      const filter = { programCode: p.programCode, packageSlug: p.packageSlug };
      const update = { ...p, priceDown };
      await Pricing.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      });
      console.log(
        `  ✓ ${p.programCode}/${p.packageSlug.padEnd(26)} ₱${String(p.priceFull).padStart(6)} → 50% down: ₱${priceDown}`
      );
      upserted++;
    }

    console.log(`\n✅ Pricing seed complete. ${upserted} packages active.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }
}

run();
