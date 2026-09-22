/**
 * One-time migration: SeaBank -> MariBank rebrand (2026-09-22).
 *
 * Collection: payments (backend/models/Payment.js)
 * Field: paymentMethod — renames the stored value 'seabank' -> 'maribank'.
 * (The Enrollment model has no paymentMethod field of its own — only Payment does.)
 *
 * Usage:
 *   node scripts/migrate-seabank-to-maribank.js            # dry run (default) — reports counts only
 *   node scripts/migrate-seabank-to-maribank.js --apply     # actually performs the update
 */
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Payment = require('../models/Payment');

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function main() {
  const apply = hasFlag('--apply');

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not configured.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const beforeSeabank = await Payment.countDocuments({ paymentMethod: 'seabank' });
    const beforeMaribank = await Payment.countDocuments({ paymentMethod: 'maribank' });
    console.log(`BEFORE — paymentMethod: 'seabank': ${beforeSeabank}, 'maribank': ${beforeMaribank}`);

    if (beforeSeabank === 0) {
      console.log('Nothing to migrate — no records with paymentMethod: "seabank".');
      return;
    }

    if (!apply) {
      console.log(`DRY RUN — would update ${beforeSeabank} record(s) from 'seabank' to 'maribank'. Re-run with --apply to perform the update.`);
      return;
    }

    const result = await Payment.updateMany(
      { paymentMethod: 'seabank' },
      { $set: { paymentMethod: 'maribank' } }
    );
    console.log(`APPLIED — matched ${result.matchedCount}, modified ${result.modifiedCount}.`);

    const afterSeabank = await Payment.countDocuments({ paymentMethod: 'seabank' });
    const afterMaribank = await Payment.countDocuments({ paymentMethod: 'maribank' });
    console.log(`AFTER — paymentMethod: 'seabank': ${afterSeabank}, 'maribank': ${afterMaribank}`);

    if (afterSeabank !== 0) {
      console.error(`WARNING: ${afterSeabank} record(s) still have paymentMethod: 'seabank' after migration.`);
      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore disconnect errors
  }
  process.exitCode = 1;
});
