const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const PASSWORD_EXPIRY_DAYS = 30;
const PASSWORD_EXPIRY_MS = PASSWORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

function getPasswordReferenceDate(user = {}) {
  const candidate =
    user.passwordChangedAt ||
    user.passwordExpiresBaseAt ||
    user.createdAt ||
    user.updatedAt ||
    new Date();

  const parsed = new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getPasswordExpiresAt(user = {}, now = new Date()) {
  if (user.passwordExpiresAt) {
    const parsed = new Date(user.passwordExpiresAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const referenceDate = getPasswordReferenceDate(user, now);
  return new Date(referenceDate.getTime() + PASSWORD_EXPIRY_MS);
}

function isPasswordExpired(user = {}, now = new Date()) {
  return getPasswordExpiresAt(user, now).getTime() <= now.getTime();
}

function getPasswordSecurityState(user = {}, now = new Date()) {
  const passwordChangedAt = getPasswordReferenceDate(user, now);
  const passwordExpiresAt = getPasswordExpiresAt(user, now);
  const passwordExpired = passwordExpiresAt.getTime() <= now.getTime();
  const remainingMs = Math.max(0, passwordExpiresAt.getTime() - now.getTime());
  const passwordExpiresInDays = passwordExpired
    ? 0
    : Math.ceil(remainingMs / (24 * 60 * 60 * 1000));

  return {
    passwordChangedAt,
    passwordExpiresAt,
    passwordExpired,
    passwordExpiresInDays,
  };
}

module.exports = {
  PASSWORD_REGEX,
  PASSWORD_EXPIRY_DAYS,
  PASSWORD_EXPIRY_MS,
  getPasswordReferenceDate,
  getPasswordExpiresAt,
  getPasswordSecurityState,
  isPasswordExpired,
};
