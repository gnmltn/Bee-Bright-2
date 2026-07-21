// TEST SCRIPT - Run this to verify login works
// Save as: test-login.js
// Run with: node test-login.js

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ MongoDB Connection Error:', err);
  process.exit(1);
});

// Define User Schema (same as your model)
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, required: true },
  password: { type: String, required: true, select: false },
  role: { type: String, enum: ['student', 'tutor', 'admin'], default: 'student' },
  gradeLevel: { type: String },
  guardianName: { type: String },
  guardianPhone: { type: String },
  isActive: { type: Boolean, default: true },
  enrollmentStatus: { type: String, default: 'not_enrolled' },
  paymentStatus: { type: String, default: 'pending' },
  lastLogin: { type: Date }
}, { timestamps: true });

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.models.User || mongoose.model('User', userSchema);

async function testLogin() {
  try {
    console.log('\n🧪 Starting Login Test...\n');

    // Test credentials
    const testEmail = 'student@beebright.com';
    const testPassword = 'Student123!';

    console.log(`📧 Looking for user: ${testEmail}`);

    // Find user WITH password (this is what was missing)
    const user = await User.findOne({ email: testEmail }).select('+password');

    if (!user) {
      console.log('❌ User not found in database');
      console.log('\n💡 Creating test user...');
      
      // Create test user
      const newUser = await User.create({
        firstName: 'Test',
        lastName: 'Student',
        email: testEmail,
        phone: '1234567890',
        password: testPassword,
        role: 'student',
        gradeLevel: 'Grade 10',
        guardianName: 'Test Guardian',
        guardianPhone: '0987654321',
        isActive: true
      });

      console.log('✅ Test user created successfully!');
      console.log(`   Email: ${testEmail}`);
      console.log(`   Password: ${testPassword}`);
      console.log('\n🔄 Retrying login...\n');

      // Try again with newly created user
      const retryUser = await User.findOne({ email: testEmail }).select('+password');
      await performLoginTest(retryUser, testPassword);
    } else {
      await performLoginTest(user, testPassword);
    }

  } catch (error) {
    console.error('❌ Test Error:', error);
  } finally {
    mongoose.connection.close();
    console.log('\n👋 Database connection closed');
  }
}

async function performLoginTest(user, password) {
  console.log('✅ User found in database');
  console.log(`   Name: ${user.firstName} ${user.lastName}`);
  console.log(`   Email: ${user.email}`);
  console.log(`   Role: ${user.role}`);
  console.log(`   Active: ${user.isActive}`);

  // Check if password field exists
  console.log(`\n🔐 Password field exists: ${!!user.password}`);
  console.log(`   Password is hashed: ${user.password?.startsWith('$2') ? 'Yes' : 'No'}`);

  if (!user.password) {
    console.log('\n❌ CRITICAL: Password field is missing!');
    console.log('   This means .select("+password") is not working properly.');
    return;
  }

  // Test password comparison
  console.log(`\n🔍 Testing password: "${password}"`);
  const isMatch = await user.comparePassword(password);

  if (isMatch) {
    console.log('✅ ✅ ✅ PASSWORD MATCH - LOGIN WOULD SUCCESS! ✅ ✅ ✅');
    console.log('\n🎉 Your login should work now!');
  } else {
    console.log('❌ PASSWORD MISMATCH - LOGIN WOULD FAIL');
    console.log('\n💡 Possible reasons:');
    console.log('   1. Wrong password entered');
    console.log('   2. Password was not hashed correctly when user was created');
    console.log('   3. bcrypt comparison is failing');
    console.log('\n🔧 To fix: Create a new user or reset the password');
  }
}

// Run the test
console.log('🚀 Login Test Script');
console.log('='.repeat(50));
testLogin();