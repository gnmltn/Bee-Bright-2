const path = require('path');
const dotenv = require('dotenv');

function normalizeBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function hasValidEncryptionKey() {
  const key = String(process.env.ENCRYPTION_KEY || '').trim();
  return key.length === 64 && /^[a-f0-9]+$/i.test(key);
}

function loadEnvironment() {
  const envPath = path.resolve(__dirname, '..', '.env');
  return dotenv.config({ path: envPath });
}

function getMongoUriFacts() {
  const mongoUri = String(process.env.MONGODB_URI || '').trim();
  const isLocalMongo = /^mongodb:\/\/(localhost|127\.0\.0\.1)/i.test(mongoUri);
  const usesMongoSrv = /^mongodb\+srv:\/\//i.test(mongoUri);
  const usesExplicitTls = /(?:\?|&)tls=true(?:&|$)|(?:\?|&)ssl=true(?:&|$)/i.test(mongoUri);
  const usesAuth = /@/.test(mongoUri);

  return {
    mongoUri,
    isLocalMongo,
    usesMongoSrv,
    usesExplicitTls,
    usesAuth,
  };
}

function getMongoConnectionOptions() {
  const { isLocalMongo, usesMongoSrv, usesExplicitTls } = getMongoUriFacts();
  const isProd = process.env.NODE_ENV === 'production';
  const shouldUseTls = !isLocalMongo && (isProd || usesMongoSrv || usesExplicitTls);

  const options = {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000),
    socketTimeoutMS: Number(process.env.MONGODB_SOCKET_TIMEOUT_MS || 45000),
    family: 4,
  };

  if (shouldUseTls) {
    options.tls = true;
  }

  const tlsCaFile = String(process.env.MONGODB_TLS_CA_FILE || '').trim();
  if (tlsCaFile) {
    options.tlsCAFile = path.resolve(tlsCaFile);
  }

  if (shouldUseTls) {
    options.tlsAllowInvalidCertificates = normalizeBoolean(
      process.env.MONGODB_TLS_ALLOW_INVALID_CERTS,
      false
    );
  }

  return options;
}

function getDatabaseSecurityStatus() {
  const isProd = process.env.NODE_ENV === 'production';
  const { isLocalMongo, usesMongoSrv, usesExplicitTls, usesAuth } = getMongoUriFacts();
  const shouldUseTls = !isLocalMongo && (isProd || usesMongoSrv || usesExplicitTls);

  return {
    localDatabase: isLocalMongo,
    authenticatedMongoUri: usesAuth || isLocalMongo,
    tlsEnforced: shouldUseTls,
    tlsCaFileConfigured: !!String(process.env.MONGODB_TLS_CA_FILE || '').trim(),
    backupRootConfigured: !!String(process.env.DB_BACKUP_DIR || '').trim(),
    backupRetentionDays: Number(process.env.DB_BACKUP_RETENTION_DAYS || 7),
    fieldEncryptionConfigured: hasValidEncryptionKey(),
  };
}

/**
 * Environment validation - run at startup.
 * Ensures required secrets and operational security settings are present.
 * Never log or expose values of JWT_SECRET, MONGODB_URI, or other secrets.
 */
function validateEnv() {
  const isProd = process.env.NODE_ENV === 'production';
  const missing = [];
  const warnings = [];
  const { mongoUri, isLocalMongo, usesMongoSrv, usesExplicitTls, usesAuth } = getMongoUriFacts();
  const shouldUseTls = !isLocalMongo && (isProd || usesMongoSrv || usesExplicitTls);
  const backupRetentionDays = Number(process.env.DB_BACKUP_RETENTION_DAYS || 7);

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    missing.push('JWT_SECRET (min 32 characters)');
  }

  if (!mongoUri) {
    missing.push('MONGODB_URI');
  } else if (isProd) {
    if (!usesAuth) {
      missing.push('MONGODB_URI with authenticated database credentials for production');
    }
    if (!isLocalMongo && !shouldUseTls) {
      missing.push('MONGODB_URI with TLS enabled for production');
    }
  }

  if (isProd && !String(process.env.DB_BACKUP_DIR || '').trim()) {
    missing.push('DB_BACKUP_DIR');
  }

  if (isProd && (!Number.isFinite(backupRetentionDays) || backupRetentionDays < 7)) {
    missing.push('DB_BACKUP_RETENTION_DAYS (minimum 7 days in production)');
  }

  if (isProd && !hasValidEncryptionKey()) {
    missing.push('ENCRYPTION_KEY (32-byte hex / 64 characters)');
  }

  if (!isProd && !String(process.env.DB_BACKUP_DIR || '').trim()) {
    warnings.push('DB_BACKUP_DIR is not set. Backups will default to backend\\backups when the script is used.');
  }

  if (!isProd && !hasValidEncryptionKey()) {
    warnings.push('ENCRYPTION_KEY is not configured. Sensitive field encryption support is not enabled.');
  }

  if (missing.length > 0) {
    const msg = `Missing or invalid required env: ${missing.join(', ')}. Copy .env.example to .env and set values.`;
    if (isProd) {
      console.error('❌', msg);
      process.exit(1);
    }
    console.warn('⚠️', msg);
  }

  warnings.forEach((warning) => {
    console.warn('⚠️', warning);
  });
}

module.exports = {
  loadEnvironment,
  validateEnv,
  getMongoConnectionOptions,
  getDatabaseSecurityStatus,
};
