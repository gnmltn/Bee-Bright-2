const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const path = require('path');
const User = require('../models/User');
const Subject = require('../models/Subject');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const LOCAL_MONGO_FALLBACK_URI = 'mongodb://127.0.0.1:27017/beebright';

function parseMongoUriFromArgs() {
  const arg = process.argv.find((entry) => entry.startsWith('--uri='));
  if (!arg) return null;
  const value = arg.slice('--uri='.length).trim();
  return value || null;
}

function shouldTryLocalFallback(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    message.includes('querysrv') ||
    message.includes('getaddrinfo')
  );
}

async function connectForSeeding() {
  const primaryUri = parseMongoUriFromArgs() || process.env.MONGODB_URI;
  if (!primaryUri) {
    throw new Error('Missing MongoDB URI. Set MONGODB_URI in backend/.env or pass --uri=<mongo-uri>.');
  }

  try {
    await mongoose.connect(primaryUri, {
      dbName: 'beebright',
      serverSelectionTimeoutMS: 12000,
    });
    return primaryUri;
  } catch (error) {
    if (!shouldTryLocalFallback(error) || primaryUri === LOCAL_MONGO_FALLBACK_URI) {
      throw error;
    }

    console.warn('⚠️ Primary MongoDB URI is unreachable. Trying local fallback...');
    await mongoose.connect(LOCAL_MONGO_FALLBACK_URI, {
      dbName: 'beebright',
      serverSelectionTimeoutMS: 12000,
    });
    return LOCAL_MONGO_FALLBACK_URI;
  }
}

const seedData = async () => {
  try {
    const connectedUri = await connectForSeeding();
    console.log(`📦 Connected to database for seeding (${connectedUri})`);

    // Clear existing data
    await User.deleteMany({});
    await Subject.deleteMany({});
    console.log('🧹 Cleared existing data');

    // Create sample subjects – all programs Mon-Sat 8:00 AM - 6:00 PM
    const defaultSchedule = 'Mon - Sat 8:00 AM - 6:00 PM';
    const subjects = [
      { name: 'Toddlers Playgroup', code: 'TPG101', description: 'Socialization, sensory play, early development', schedule: defaultSchedule, price: 3000, duration: '2 hours per session', capacity: 15 },
      { name: 'Pre-Kindergarten Readiness Program', code: 'PKR105', description: 'Foundational academic skills, phonics, basic reading & writing', schedule: defaultSchedule, price: 3200, duration: '2 hours per session', capacity: 15 },
      { name: 'Academic Tutorial', code: 'ACT102', description: 'Subject-based support Grade 1 to Junior High', schedule: defaultSchedule, price: 2500, duration: '2 hours per session', capacity: 20 },
      { name: 'SPED Tutorial', code: 'SPT103', description: 'Individualized learning support, IEP-based', schedule: defaultSchedule, price: 3500, duration: '2 hours per session', capacity: 10 },
      { name: 'Examination Preparation', code: 'EXP106', description: 'Test mastery, mock exams, test-taking strategies', schedule: defaultSchedule, price: 3500, duration: '2 hours per session', capacity: 15 },
      { name: 'Kindergarten Readiness Program', code: 'KRP104', description: 'School-entry preparation, reading & writing readiness', schedule: defaultSchedule, price: 3000, duration: '2 hours per session', capacity: 12 }
    ];

    const createdSubjects = await Subject.insertMany(subjects);
    console.log(`📚 Created ${createdSubjects.length} subjects`);

    // Create sample users
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('demo123', salt);

    const users = [
      {
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        email: 'student@beebright.com',
        phone: '+639123456789',
        password: hashedPassword,
        role: 'student',
        gradeLevel: 'Grade 7',
        guardianName: 'Maria Dela Cruz',
        guardianPhone: '+639876543210'
      },
      {
        firstName: 'Maria',
        lastName: 'Santos',
        email: 'tutor@beebright.com',
        phone: '+639234567890',
        password: hashedPassword,
        role: 'tutor',
        gradeLevel: null,
        guardianName: null
      },
      {
        firstName: 'Admin',
        lastName: 'User',
        email: 'admin@beebright.com',
        phone: '+639345678901',
        password: hashedPassword,
        role: 'admin',
        gradeLevel: null,
        guardianName: null
      }
    ];

    const createdUsers = await User.insertMany(users);
    console.log(`👤 Created ${createdUsers.length} users`);

    console.log('✅ Seed data created successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  }
};

seedData();