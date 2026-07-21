# Bee Bright Database Security and Recovery

## Implemented Controls
- MongoDB access is gated by API-side RBAC and JWT authentication in [auth.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/middleware/auth.js).
- Passwords are stored as bcrypt hashes in [User.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/models/User.js).
- Request payloads are sanitized against NoSQL operator injection in [sanitize.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/middleware/sanitize.js).
- Mongoose query hardening is enabled at startup with `strictQuery` and `sanitizeFilter` in [server.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/server.js).
- Production environment validation now enforces strong JWT secrets, authenticated MongoDB URIs, TLS on non-local databases, backup configuration, and a valid encryption key in [env.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/config/env.js).
- Database security status is logged at backend startup from [server.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/server.js) so deployment checks are visible during defense.

## TLS and Connection Security
- Non-local production MongoDB connections are forced to use TLS through [env.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/config/env.js).
- Optional CA pinning is supported with `MONGODB_TLS_CA_FILE`.
- Invalid TLS certificates are blocked by default unless `MONGODB_TLS_ALLOW_INVALID_CERTS=true` is explicitly set for controlled testing.

## Backup Controls
- The backup script in [backup-mongodb.ps1](/c:/BRIGHTBEE/beebright-ui-showcase/backend/scripts/backup-mongodb.ps1) creates:
  - compressed `mongodump` archives
  - SHA-256 hash files
  - JSON manifest files with timestamp, size, hash, retention, and TLS expectation
- Old backup archives are pruned automatically based on `DB_BACKUP_RETENTION_DAYS`.
- The scheduled-task helper in [register-backup-task.ps1](/c:/BRIGHTBEE/beebright-ui-showcase/backend/scripts/register-backup-task.ps1) can register a daily automated backup on Windows.

## Restore Controls
- The restore script in [restore-mongodb.ps1](/c:/BRIGHTBEE/beebright-ui-showcase/backend/scripts/restore-mongodb.ps1) performs controlled restores from a `.gz` archive using `mongorestore`.
- Restore validation should always happen in staging first before any production restore.

## Recommended Defense Workflow
1. Set `MONGODB_URI`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DB_BACKUP_DIR`, and `DB_BACKUP_RETENTION_DAYS` in [backend/.env](/c:/BRIGHTBEE/beebright-ui-showcase/backend/.env).
2. For production, use a MongoDB URI with database authentication and TLS enabled.
3. Run [backup-mongodb.ps1](/c:/BRIGHTBEE/beebright-ui-showcase/backend/scripts/backup-mongodb.ps1) once manually to generate a backup archive, hash, and manifest.
4. Register the daily backup task with [register-backup-task.ps1](/c:/BRIGHTBEE/beebright-ui-showcase/backend/scripts/register-backup-task.ps1).
5. Test a staged restore with [restore-mongodb.ps1](/c:/BRIGHTBEE/beebright-ui-showcase/backend/scripts/restore-mongodb.ps1).

## Panel-Ready Evidence
- Startup now shows whether TLS, authenticated MongoDB URI, backup directory, retention policy, and field-encryption support are configured.
- Backups are no longer only “documented”; they now produce verifiable integrity artifacts through SHA-256 hashes and manifest files.
- Recovery is no longer theoretical; the project now includes a concrete restore script and a concrete scheduling script for automated backups.

## Defense Talking Point
Bee Bright now demonstrates database security through layered controls: authenticated MongoDB access, TLS-enforced production connections, Mongoose query hardening, bcrypt password hashing, NoSQL sanitization, audit logs, integrity-checked backups, automated backup scheduling, and a concrete restore procedure.
