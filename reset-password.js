// QUICK PASSWORD RESET SCRIPT
// Save as: reset-password.js
// Run with: node reset-password.js

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ Connection Error:', err);
  process.exit(1);
});

const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: { type: String, lowercase: true },
  phone: String,
  password: { type: String, select: false },
  role: String,
  gradeLevel: String,
  guardianName: String,
  guardianPhone: String,
  isActive: Boolean
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

async function resetPassword() {
  try {
    // CHANGE THESE VALUES FOR YOUR USER
    const userEmail = 'student@beebright.com'; // Email of user to reset
    const newPassword = 'Student123!'; // New password to set

    console.log(`\n🔄 Resetting password for: ${userEmail}`);
    console.log(`   New password will be: ${newPassword}\n`);

    const user = await User.findOne({ email: userEmail });

    if (!user) {
      console.log('❌ User not found with email:', userEmail);
      console.log('\n📋 Available users:');
      const allUsers = await User.find({}, 'email firstName lastName role');
      allUsers.forEach(u => {
        console.log(`   - ${u.email} (${u.firstName} ${u.lastName}) - ${u.role}`);
      });
      return;
    }

    console.log('✅ User found:', user.firstName, user.lastName);
    console.log(`   Role: ${user.role}`);
    console.log(`   Active: ${user.isActive}`);

    // Set new password (will be auto-hashed by pre-save hook)
    user.password = newPassword;
    await user.save();

    console.log('\n✅ ✅ ✅ PASSWORD RESET SUCCESSFUL! ✅ ✅ ✅');
    console.log(`\n🔐 Login credentials:`);
    console.log(`   Email: ${userEmail}`);
    console.log(`   Password: ${newPassword}`);
    console.log(`   Role: ${user.role}`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    mongoose.connection.close();
    console.log('\n👋 Done!\n');
  }
}

resetPassword();