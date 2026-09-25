/**
 * Turns a verified PendingParentSignup into a real User — and ONLY at the moment the
 * completed enrollment (with its payment proof) is being submitted. Until then the
 * Users collection is never touched by a signup. See models/PendingParentSignup.js.
 */
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const PendingParentSignup = require('../models/PendingParentSignup');
const { checkMobileNumberUnique } = require('./validation');

function signupError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/** The pending signup the wizard's enrollment token belongs to, or null. */
async function findPendingFromRequest(req) {
  const header = req.headers?.authorization;
  if (!header || !header.startsWith('Bearer')) return null;
  const token = header.split(' ')[1];
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
  if (decoded?.scope !== 'enrollment' || !mongoose.Types.ObjectId.isValid(decoded.id)) return null;
  return PendingParentSignup.findById(decoded.id).select('+passwordHash');
}

/** Cheap up-front checks so a doomed submit fails before any file or record is written. */
async function assertPendingReady(pending) {
  if (!pending.emailVerifiedAt) {
    throw signupError(401, 'Email not verified. Please verify your email before submitting your enrollment.');
  }
  if (await User.exists({ email: pending.email })) {
    throw signupError(409, 'An account with this email already exists. Please go back and use a different email, or log in.');
  }
  if (!(await checkMobileNumberUnique(pending.phone, null))) {
    throw signupError(409, 'That mobile number was just registered to another account. Please go back to the Account step and use a different number.');
  }
}

/** Creates the real (still inactive, awaiting admin approval) parent User with the pending record's `_id`. */
async function createUserFromPending(pending) {
  await assertPendingReady(pending);
  const user = new User({
    _id: pending._id,
    firstName: pending.firstName,
    middleName: pending.middleName,
    lastName: pending.lastName,
    email: pending.email,
    phone: pending.phone,
    password: pending.passwordHash,
    role: 'parent',
    isActive: false,
    emailVerifiedAt: pending.emailVerifiedAt,
    enrollmentDraft: false,
    enrollmentStatus: 'pending_payment',
  });
  user.$locals.passwordAlreadyHashed = true;
  try {
    await user.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw signupError(409, 'An account with this email or mobile number already exists. Please go back and use different details.');
    }
    throw err;
  }
  return user;
}

const discardPending = (pending) => PendingParentSignup.deleteOne({ _id: pending._id }).catch(() => {});

module.exports = { findPendingFromRequest, assertPendingReady, createUserFromPending, discardPending, signupError };
