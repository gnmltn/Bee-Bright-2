const crypto = require('crypto');
const TrustedDevice = require('../models/TrustedDevice');

const TRUSTED_DEVICE_COOKIE_NAME = 'beebright_trusted_device';
const MAX_TRUSTED_DEVICES_PER_USER = 3;

const TRUSTED_DURATION_BY_ROLE_DAYS = {
  super_admin: 2,
  admin: 3,
  tutor: 7,
  student: 14,
};

function parseCookies(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex === -1) return acc;
      const key = decodeURIComponent(entry.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(entry.slice(separatorIndex + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function getTrustedDurationDays(role) {
  return TRUSTED_DURATION_BY_ROLE_DAYS[role] || 3;
}

function getTrustedExpiryDate(role, now = new Date()) {
  const days = getTrustedDurationDays(role);
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

function getClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded) return forwarded;
  return String(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '').trim();
}

function getClientUserAgent(req) {
  return String(req?.headers?.['user-agent'] || '').trim();
}

function getDeviceIdentifier(req) {
  const userAgent = String(req?.headers?.['user-agent'] || '').trim();
  const platform = String(req?.headers?.['sec-ch-ua-platform'] || '').trim();
  const language = String(req?.headers?.['accept-language'] || '').trim();
  return `${userAgent}|${platform}|${language}`;
}

function getDeviceName(req) {
  const userAgent = getClientUserAgent(req);
  if (!userAgent) return 'Unknown browser';
  return userAgent.slice(0, 120);
}

function getTrustedDeviceTokenFromRequest(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  return cookies[TRUSTED_DEVICE_COOKIE_NAME] || null;
}

function getBaseCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  const sameSiteRaw = String(process.env.AUTH_COOKIE_SAME_SITE || 'lax').trim().toLowerCase();
  const sameSite = ['lax', 'strict', 'none'].includes(sameSiteRaw) ? sameSiteRaw : 'lax';
  const secure = sameSite === 'none' ? true : isProduction;
  const options = {
    httpOnly: true,
    sameSite,
    secure,
    path: '/',
  };

  const domain = String(process.env.AUTH_COOKIE_DOMAIN || '').trim();
  if (domain) {
    options.domain = domain;
  }

  return options;
}

function setTrustedDeviceCookie(res, token, trustedExpiryDate) {
  if (!res || !token || !trustedExpiryDate) return;
  const maxAge = Math.max(1, new Date(trustedExpiryDate).getTime() - Date.now());
  res.cookie(TRUSTED_DEVICE_COOKIE_NAME, token, {
    ...getBaseCookieOptions(),
    maxAge,
  });
}

function clearTrustedDeviceCookie(res) {
  if (!res) return;
  res.clearCookie(TRUSTED_DEVICE_COOKIE_NAME, getBaseCookieOptions());
}

async function revokeTrustedDeviceByToken(token, reason = 'revoked') {
  if (!token) return null;
  const tokenHash = hashValue(token);
  return TrustedDevice.findOneAndUpdate(
    { tokenHash, revokedAt: null },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: reason,
      },
    },
    { new: true }
  );
}

async function revokeTrustedDeviceFromRequest(req, reason = 'revoked') {
  const token = getTrustedDeviceTokenFromRequest(req);
  if (!token) return null;
  return revokeTrustedDeviceByToken(token, reason);
}

async function invalidateAllTrustedDevicesForUser(userId, reason = 'security_reset') {
  if (!userId) return;
  await TrustedDevice.updateMany(
    { userId, revokedAt: null },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: reason,
      },
    }
  );
}

async function validateTrustedDevice(req, user) {
  const token = getTrustedDeviceTokenFromRequest(req);
  if (!token) {
    return { trusted: false, reason: 'missing_token' };
  }

  const tokenHash = hashValue(token);
  const record = await TrustedDevice.findOne({
    tokenHash,
    userId: user._id,
    revokedAt: null,
  });

  if (!record) {
    return { trusted: false, reason: 'not_found' };
  }

  const now = new Date();
  if (!record.trustedExpiryDate || record.trustedExpiryDate.getTime() <= now.getTime()) {
    await TrustedDevice.updateOne(
      { _id: record._id },
      { $set: { revokedAt: now, revokedReason: 'expired' } }
    );
    return { trusted: false, reason: 'expired' };
  }

  const userAgentHash = hashValue(getClientUserAgent(req));
  const ipHash = hashValue(getClientIp(req));
  const deviceIdentifierHash = hashValue(getDeviceIdentifier(req));

  const hasUserAgentMismatch = !!record.userAgentHash && record.userAgentHash !== userAgentHash;
  const hasDeviceMismatch = !!record.deviceIdentifierHash && record.deviceIdentifierHash !== deviceIdentifierHash;
  const hasIpMismatch = !!record.ipHash && record.ipHash !== ipHash;

  if (hasUserAgentMismatch || hasDeviceMismatch || hasIpMismatch) {
    await TrustedDevice.updateOne(
      { _id: record._id },
      {
        $set: {
          revokedAt: now,
          revokedReason: 'suspicious_login',
        },
      }
    );
    return { trusted: false, reason: 'suspicious_login' };
  }

  await TrustedDevice.updateOne(
    { _id: record._id },
    {
      $set: {
        lastUsedAt: now,
      },
    }
  );

  return { trusted: true, reason: 'trusted', record };
}

async function registerTrustedDevice(req, user) {
  const now = new Date();
  const trustedExpiryDate = getTrustedExpiryDate(user.role, now);
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashValue(rawToken);
  const deviceIdentifierHash = hashValue(getDeviceIdentifier(req));

  const update = {
    tokenHash,
    userAgentHash: hashValue(getClientUserAgent(req)),
    ipHash: hashValue(getClientIp(req)),
    deviceName: getDeviceName(req),
    lastVerifiedLogin: now,
    lastUsedAt: now,
    trustedExpiryDate,
    revokedAt: null,
    revokedReason: null,
  };

  await TrustedDevice.findOneAndUpdate(
    {
      userId: user._id,
      deviceIdentifierHash,
    },
    {
      $set: update,
      $setOnInsert: {
        userId: user._id,
        deviceIdentifierHash,
      },
    },
    {
      upsert: true,
      new: true,
    }
  );

  const activeDevices = await TrustedDevice.find({
    userId: user._id,
    revokedAt: null,
    trustedExpiryDate: { $gt: now },
  })
    .sort({ lastVerifiedLogin: -1, createdAt: -1 })
    .select('_id');

  if (activeDevices.length > MAX_TRUSTED_DEVICES_PER_USER) {
    const staleDeviceIds = activeDevices.slice(MAX_TRUSTED_DEVICES_PER_USER).map((item) => item._id);
    await TrustedDevice.updateMany(
      { _id: { $in: staleDeviceIds } },
      {
        $set: {
          revokedAt: now,
          revokedReason: 'max_devices_exceeded',
        },
      }
    );
  }

  return {
    token: rawToken,
    trustedExpiryDate,
  };
}

module.exports = {
  TRUSTED_DEVICE_COOKIE_NAME,
  getTrustedDurationDays,
  setTrustedDeviceCookie,
  clearTrustedDeviceCookie,
  getTrustedDeviceTokenFromRequest,
  validateTrustedDevice,
  registerTrustedDevice,
  revokeTrustedDeviceByToken,
  revokeTrustedDeviceFromRequest,
  invalidateAllTrustedDevicesForUser,
};
