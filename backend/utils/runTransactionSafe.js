/**
 * Runs `work(session)` inside a single MongoDB transaction: if any step throws, everything
 * done with that session is rolled back and the error propagates — no half-committed writes.
 * On a standalone MongoDB (local dev without a replica set, where transactions aren't
 * supported) it falls back to running `work(null)` without a session, matching the same
 * fallback already used by scheduleController.js's substitution flows.
 */
const mongoose = require('mongoose');

async function runTransactionSafe(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    const msg = String(error?.message || '');
    if (msg.includes('Transaction numbers are only allowed on a replica set member or mongos')) {
      return work(null);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

module.exports = { runTransactionSafe };
