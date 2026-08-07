/**
 * Import pricing seed from pricing-seed.json into MongoDB using MONGO_URI env.
 * Usage: node backend/scripts/import-pricing.js
 */
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Pricing = require('../models/Pricing');

const FILE = path.join(__dirname, 'pricing-seed.json');
const MONGO = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO || 'mongodb://127.0.0.1:27017/beebright';

async function run() {
  if (!fs.existsSync(FILE)) {
    console.error('Seed file not found:', FILE);
    process.exit(1);
  }

  const raw = fs.readFileSync(FILE, 'utf8');
  let items;
  try {
    items = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse JSON:', err.message);
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to Mongo at', MONGO);
  } catch (err) {
    console.error('Mongo connect failed:', err.message);
    process.exit(1);
  }

  try {
    for (const p of items) {
      const filter = { programCode: p.programCode, packageSlug: p.packageSlug };
      const update = { ...p, active: true };
      const opts = { upsert: true, new: true, setDefaultsOnInsert: true };
      const doc = await Pricing.findOneAndUpdate(filter, update, opts);
      console.log('Upserted', doc.programCode, doc.packageSlug, doc.priceFull);
    }
    console.log('Import complete.');
    process.exit(0);
  } catch (err) {
    console.error('Import failed:', err.message);
    process.exit(1);
  }
}

run();
