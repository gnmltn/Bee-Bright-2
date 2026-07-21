/**
 * Optional field-level encryption for sensitive data (e.g. guardian phone).
 * Uses AES-256-GCM. Set ENCRYPTION_KEY in .env (32-byte hex = 64 chars).
 * If ENCRYPTION_KEY is not set, encrypt/decrypt return plain value (no-op).
 * Generate key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || typeof raw !== 'string' || raw.length !== 64 || !/^[a-f0-9]+$/i.test(raw)) {
    return null;
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Encrypt a string. Returns plain text if ENCRYPTION_KEY is not set.
 */
function encrypt(plainText) {
  if (plainText == null || plainText === '') return plainText;
  const key = getKey();
  if (!key) return String(plainText);
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_LENGTH });
    const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  } catch (err) {
    console.error('Encryption error:', err.message);
    return String(plainText);
  }
}

/**
 * Decrypt a string. If value does not start with "enc:" or key not set, return as-is.
 */
function decrypt(cipherText) {
  if (cipherText == null || cipherText === '') return cipherText;
  const str = String(cipherText);
  if (!str.startsWith('enc:')) return str;
  const key = getKey();
  if (!key) return str;
  try {
    const parts = str.slice(4).split(':');
    if (parts.length !== 3) return str;
    const [ivHex, tagHex, encHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    return decipher.update(enc) + decipher.final('utf8');
  } catch (err) {
    console.error('Decryption error:', err.message);
    return str;
  }
}

module.exports = { encrypt, decrypt };
