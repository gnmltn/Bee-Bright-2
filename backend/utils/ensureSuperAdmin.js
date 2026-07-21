const User = require('../models/User');

/**
 * Ensure there is at least one super admin user.
 * Runs automatically on server startup (see server.js).
 * The env password is only used when creating the account for the first time.
 * Existing super admin accounts keep their saved database password.
 *
 * Configuration (backend/.env):
 * - SUPER_ADMIN_EMAIL
 * - SUPER_ADMIN_PASSWORD
 * - SUPER_ADMIN_PHONE (optional)
 */
async function ensureSuperAdmin() {
  const email = process.env.SUPER_ADMIN_EMAIL || 'superadmin@beebright.edu.ph';
  const phone = process.env.SUPER_ADMIN_PHONE || '+639123456789';
  const password = process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe123!';

  const existing = await User.findOne({ email }).lean();
  if (existing) {
    console.log(`👑 Super admin already exists: ${email}`);
    return;
  }

  await User.create({
    firstName: 'Super',
    lastName: 'Admin',
    email,
    phone,
    password,
    role: 'super_admin',
    gradeLevel: undefined,
    guardianName: 'System',
    guardianPhone: ''
  });

  console.log('✅ Super admin created:', email);
}

module.exports = { ensureSuperAdmin };

