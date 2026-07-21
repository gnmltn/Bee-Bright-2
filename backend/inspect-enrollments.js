// INSPECT ENROLLMENTS - debug why schedule options show no students
// Run from backend folder:
//   node inspect-enrollments.js

const mongoose = require('mongoose');
require('dotenv').config();

const Enrollment = require('./models/Enrollment');

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');
    console.log('MONGODB_URI:', process.env.MONGODB_URI);

    const total = await Enrollment.countDocuments({});
    const active = await Enrollment.countDocuments({ status: 'active' });
    const pending = await Enrollment.countDocuments({ status: 'pending' });
    const cancelled = await Enrollment.countDocuments({ status: 'cancelled' });
    const completed = await Enrollment.countDocuments({ status: 'completed' });

    console.log('\n📊 Enrollment counts:');
    console.log('  total:', total);
    console.log('  active:', active);
    console.log('  pending:', pending);
    console.log('  completed:', completed);
    console.log('  cancelled:', cancelled);

    const sample = await Enrollment.find({ status: 'active' })
      .populate('student', 'firstName lastName email enrollmentStatus')
      .populate('selectedSubjects', 'name code')
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();

    console.log('\n🔎 Sample active enrollments (up to 5):');
    if (sample.length === 0) {
      console.log('  (none)');
    } else {
      for (const en of sample) {
        console.log('  - enrollmentId:', String(en._id));
        console.log('    status:', en.status, 'paymentStatus:', en.paymentStatus);
        console.log('    student:', en.student?.email, en.student?.firstName, en.student?.lastName, 'userEnrollmentStatus:', en.student?.enrollmentStatus);
        console.log('    selectedSubjects:', Array.isArray(en.selectedSubjects) ? en.selectedSubjects.map((s) => s.name).join(', ') : '(none)');
      }
    }
  } catch (err) {
    console.error('❌ Error inspecting enrollments:', err);
  } finally {
    await mongoose.connection.close();
    console.log('\n👋 Done.');
  }
}

main();

