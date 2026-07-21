# Bee Bright Backend – Security

## 1. .env protection

- **Never commit `.env`.** It is listed in `.gitignore`.
- Use `.env.example` as a template: copy to `.env` and set real values.
- **Required in production:** `JWT_SECRET` (min 32 chars), `MONGODB_URI`. The app calls `validateEnv()` at startup and exits in production if these are missing or invalid.
- Do not log or expose `JWT_SECRET`, `MONGODB_URI`, or any secret in responses or logs.

## 2. Input validation

- **express-validator** is used on auth, enrollment submit, and payment routes.
- **NoSQL injection guard** (`middleware/sanitize.js`) strips `$` and `.` from `req.body` and `req.query` so they are not used as Mongo operators.
- Validation rules live in `middleware/inputValidation.js` and in route files. Add new rules there for new endpoints.

## 3. Multer file validation

- **Allowed types:** PDF, video (mp4, webm, mov, avi), images (jpeg, png, gif, webp, svg), Word, Excel, text/csv.
- **Checks:** MIME type allowlist, **extension allowlist** (so extension must match an allowed one), **max file size** (80MB), **max filename length** (200 chars).
- Implemented in `utils/uploadMaterial.js`. Profile images are sent as base64 in JSON (no multer); size limit is enforced in the auth controller.

## 4. Helmet

- **Helmet** is enabled in `server.js` for security headers (e.g. X-Content-Type-Options, X-Frame-Options).
- `contentSecurityPolicy` is disabled by default so existing inline scripts and assets still work; you can enable and tune it for production.

## 5. JWT authentication & secure session expiry

- **Protected routes** use `protect` middleware; token is read from `Authorization: Bearer <token>`.
- **Role checks** use `authorize('student'|'tutor'|'admin')`.
- **JWT_SECRET** is required at startup (see `.env` / `config/env.js`). Use a long, random secret (e.g. 64+ chars).
- **Session expiry**: Tokens include an expiry via `JWT_EXPIRES_IN` (default `30d`). Set in `.env` (e.g. `24h`, `7d`, `30d`). When a token expires:
  - Backend returns 401 with message "Session expired. Please log in again." and code `TOKEN_EXPIRED`.
  - Frontend clears token, redirects to login, and shows a "Session expired" toast.
- Logout is client-side (remove token); for instant invalidation you would need a server-side blacklist.

## 6. MongoDB

- **Connection:** Use `MONGODB_URI` with authentication (e.g. `mongodb+srv://user:password@cluster...`). Never log the full URI.
- **NoSQL injection:** The sanitize middleware removes `$` and `.` from body/query. Prefer structured queries (e.g. `findById`, `findOne({ email })`) instead of passing raw user input into query objects.
- **Encryption at rest:** With MongoDB Atlas, encryption at rest is provided by the platform. For self-hosted MongoDB, configure it at the server/filesystem level.

## 7. Encryption for sensitive data

- **Passwords:** Stored only as bcrypt hashes (see `User` model); never stored in plain text.
- **Optional field-level encryption:** `utils/encryption.js` provides `encrypt()` / `decrypt()` for strings (e.g. guardian phone). Set `ENCRYPTION_KEY` in `.env` (32-byte hex, 64 chars). If not set, no encryption is applied.
- **In transit:** Use HTTPS in production so all traffic (including tokens and form data) is encrypted in transit.

## Quick checklist

- [ ] `.env` is not committed; `.env.example` has no real secrets.
- [ ] `JWT_SECRET` and `MONGODB_URI` are set and strong in production.
- [ ] All user input is validated and sanitized; body/query are sanitized for NoSQL.
- [ ] File uploads are validated (type, extension, size).
- [ ] Helmet is enabled; CSP tuned if needed.
- [ ] MongoDB uses an authenticated URI; no secrets in logs.
- [ ] HTTPS in production; optionally set `ENCRYPTION_KEY` and use encryption util for sensitive fields.
