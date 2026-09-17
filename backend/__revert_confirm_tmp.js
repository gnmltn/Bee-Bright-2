require('dotenv').config();
const mongoose = require('mongoose');
require('./models/User');
require('./models/Subject');
const Schedule = require('./models/Schedule');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const ids = ['6aa6dc3f7c63a543eeeccd5a', '6aa6f07f4fae9153d613211c'];

  // Revert ONLY the date field, exactly as scoped. startTime/endTime/everything else untouched.
  for (const id of ids) {
    await Schedule.updateOne(
      { _id: id },
      { $set: { date: new Date('2026-10-05T00:00:00.000Z') } }
    );
  }

  const after = await Schedule.find({ _id: { $in: ids } })
    .populate('student', 'firstName lastName email')
    .populate('tutor', 'firstName lastName email')
    .populate('subject', 'name code');
  for (const d of after) {
    console.log(JSON.stringify({
      id: String(d._id),
      sessionType: d.sessionType,
      date: d.date,
      startTime: d.startTime,
      endTime: d.endTime,
      student: d.student ? `${d.student.firstName} ${d.student.lastName} (${d.student.email})` : null,
      tutor: d.tutor ? `${d.tutor.firstName} ${d.tutor.lastName} (${d.tutor.email})` : null,
      subject: d.subject ? d.subject.name : null,
      updatedAt: d.updatedAt,
    }, null, 2));
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
