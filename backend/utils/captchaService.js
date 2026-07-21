const crypto = require('crypto');

const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes
const challenges = new Map(); // captchaId -> { answerText, expiresAt, metadata }
const CAPTCHA_LENGTH = 6;
const MAX_ATTEMPTS = 3;
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomInt(max) {
  return crypto.randomInt(0, max);
}

function randomHexColor(min = 120, max = 200) {
  const clamp = (value) => Math.max(0, Math.min(255, value));
  const r = clamp(min + randomInt(max - min + 1));
  const g = clamp(min + randomInt(max - min + 1));
  const b = clamp(min + randomInt(max - min + 1));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function generateCaptchaText() {
  let text = '';
  for (let i = 0; i < CAPTCHA_LENGTH; i += 1) {
    text += CAPTCHA_CHARS[randomInt(CAPTCHA_CHARS.length)];
  }
  return text;
}

function createNoiseLines(width, height, count) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const x1 = randomInt(width);
    const y1 = randomInt(height);
    const x2 = randomInt(width);
    const y2 = randomInt(height);
    lines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${randomHexColor(140, 210)}" stroke-width="${1 + randomInt(2)}" opacity="0.8" />`
    );
  }
  return lines.join('');
}

function createNoiseDots(width, height, count) {
  const dots = [];
  for (let i = 0; i < count; i += 1) {
    dots.push(
      `<circle cx="${randomInt(width)}" cy="${randomInt(height)}" r="${1 + randomInt(2)}" fill="${randomHexColor(120, 220)}" opacity="0.7" />`
    );
  }
  return dots.join('');
}

function generateCaptchaSvg(text) {
  const width = 260;
  const height = 90;
  const spacing = width / (text.length + 1);

  const letters = text
    .split('')
    .map((char, index) => {
      const x = Math.round(spacing * (index + 1));
      const y = 56 + randomInt(16) - 8;
      const rotate = randomInt(40) - 20;
      const fontSize = 36 + randomInt(8);
      const fill = randomHexColor(15, 80);
      return `<text x="${x}" y="${y}" text-anchor="middle" font-family="Verdana, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="${fill}" transform="rotate(${rotate} ${x} ${y})">${char}</text>`;
    })
    .join('');

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f6f6f6"/>
  ${createNoiseLines(width, height, 7)}
  ${createNoiseDots(width, height, 24)}
  ${letters}
</svg>`.trim();

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function cleanupExpiredChallenges() {
  const now = Date.now();
  for (const [captchaId, value] of challenges.entries()) {
    if (value.expiresAt <= now) {
      challenges.delete(captchaId);
    }
  }
}

function createCaptchaChallenge(metadata = {}) {
  cleanupExpiredChallenges();

  const captchaText = generateCaptchaText();
  const captchaId = crypto.randomUUID();
  const expiresAt = Date.now() + CAPTCHA_TTL_MS;

  challenges.set(captchaId, {
    answerText: captchaText,
    expiresAt,
    metadata,
    attempts: 0
  });

  return {
    captchaId,
    imageData: generateCaptchaSvg(captchaText),
    prompt: 'Type the text shown in the captcha image (case-sensitive)',
    maxAttempts: MAX_ATTEMPTS,
    attemptsRemaining: MAX_ATTEMPTS,
    expiresInSeconds: Math.floor(CAPTCHA_TTL_MS / 1000)
  };
}

function verifyCaptchaAnswer(captchaId, captchaAnswer) {
  cleanupExpiredChallenges();

  if (!captchaId || !captchaAnswer) {
    return { valid: false, reason: 'missing' };
  }

  const challenge = challenges.get(captchaId);
  if (!challenge) {
    return { valid: false, reason: 'expired' };
  }

  if (challenge.answerText !== String(captchaAnswer).trim()) {
    challenge.attempts += 1;
    const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - challenge.attempts);
    if (attemptsRemaining === 0) {
      challenges.delete(captchaId);
      return { valid: false, reason: 'max_attempts', attemptsRemaining: 0 };
    }
    return { valid: false, reason: 'invalid', attemptsRemaining };
  }

  challenges.delete(captchaId); // one-time use after success
  return { valid: true, metadata: challenge.metadata };
}

module.exports = {
  createCaptchaChallenge,
  verifyCaptchaAnswer
};
