const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');

function getArgValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return '';
  return String(process.argv[index + 1] || '').trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function main() {
  const email = getArgValue('--email').toLowerCase();
  const promoteExisting = hasFlag('--promote-existing');
  const firstName = getArgValue('--first-name') || 'Super';
  const lastName = getArgValue('--last-name') || 'Admin';

  if (!email) {
    console.error('Missing required --email argument.');
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not configured.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const existingUser = await User.findOne({ email }).select('+password');

    if (existingUser) {
      console.log(`FOUND ${existingUser.email} role=${existingUser.role}`);

      if (existingUser.role === 'super_admin') {
        console.log('This account is already a super admin.');
        return;
      }

      if (!promoteExisting) {
        console.log('Existing account found. Re-run with --promote-existing to convert it into a super admin.');
        process.exitCode = 2;
        return;
      }

      existingUser.role = 'super_admin';
      existingUser.isActive = true;
      existingUser.isArchived = false;
      existingUser.archivedAt = null;
      await existingUser.save();

      console.log(`PROMOTED ${existingUser.email} to super_admin`);
      return;
    }

    const password = process.env.SUPER_ADMIN_PASSWORD || '';
    if (!password) {
      console.error('SUPER_ADMIN_PASSWORD is not configured in backend/.env.');
      process.exitCode = 1;
      return;
    }

    const phone = process.env.SUPER_ADMIN_PHONE || '+639001112222';
    const createdUser = await User.create({
      firstName,
      lastName,
      email,
      phone,
      password,
      role: 'super_admin',
      guardianName: 'System',
      guardianPhone: '',
    });

    console.log(`CREATED ${createdUser.email} as super_admin`);
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
