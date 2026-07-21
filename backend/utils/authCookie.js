const AUTH_COOKIE_NAME = 'beebright_token';

function parseDurationToMs(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 30 * 24 * 60 * 60 * 1000;

  const match = raw.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000;

  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
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

function getAuthCookieOptions() {
  return {
    ...getBaseCookieOptions(),
    maxAge: parseDurationToMs(process.env.JWT_COOKIE_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '30d'),
  };
}

function getAuthCookieClearOptions() {
  return getBaseCookieOptions();
}

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

function getAuthTokenFromCookies(req) {
  const cookies = parseCookies(req?.headers?.cookie);
  return cookies[AUTH_COOKIE_NAME] || null;
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieClearOptions());
}

module.exports = {
  AUTH_COOKIE_NAME,
  getAuthTokenFromCookies,
  setAuthCookie,
  clearAuthCookie,
};
