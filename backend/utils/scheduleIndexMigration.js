const Schedule = require('../models/Schedule');

async function migrateScheduleIndexes() {
  try {
    const collection = Schedule.collection;
    const indexes = await collection.indexes();

    const legacyGlobalSlotIndex = indexes.find((idx) =>
      idx &&
      idx.unique === true &&
      idx.key &&
      idx.key.date === 1 &&
      idx.key.startTime === 1 &&
      Object.keys(idx.key).length === 2
    );

    if (legacyGlobalSlotIndex?.name) {
      await collection.dropIndex(legacyGlobalSlotIndex.name);
      console.log(`✅ Dropped legacy schedule index: ${legacyGlobalSlotIndex.name}`);
    }

    await collection.createIndex({ date: 1, startTime: 1 }, { background: true });
    await collection.createIndex({ tutor: 1, date: 1, startTime: 1 }, { unique: true, background: true });
  } catch (error) {
    console.warn('⚠️ Schedule index migration warning:', error?.message || error);
  }
}

module.exports = { migrateScheduleIndexes };
