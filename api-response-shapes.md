# BeeBright API response shapes (for the Android app)

Read-only scan of `backend/` and `frontend/src/`. **No code was changed.** Every sample below is invented (fake names, fake ObjectIds); shapes come from the code paths cited. All paths are relative to `Bee-Bright-2/`. Nothing here was captured from a live call, so where a shape depends on Mongoose defaults I say so.

---

## 0. Conventions that apply to every endpoint

### Base URL and mounting
- Backend mounts everything under `/api` (`backend/server.js:161-181`). Local default port 5001 (web default `http://localhost:5001/api`, `frontend/src/services/api.ts:7`).
- Web code calls paths **without** the `/api` prefix because axios `baseURL` already ends in `/api` (`frontend/src/services/api.ts:6-7`). In this document every path includes `/api`.

### Authentication (header **or** cookie)
- Server accepts **either**:
  1. `Authorization: Bearer <JWT>` header (`backend/middleware/auth.js:22`), or
  2. httpOnly cookie named `beebright_token` (`backend/utils/authCookie.js:1`, read at `backend/middleware/auth.js:27`).
- Login returns the JWT in the JSON body as `token` **and** sets the cookie (`backend/controllers/authController.js:203-253`, cookie via `attachLoginSession` `:167-169`).
- The web client sends the Bearer header from browser storage (`frontend/src/services/api.ts:16-24`, `frontend/src/utils/authStorage.ts:25`) and also `withCredentials: true` (`api.ts:8`). **An Android app should use the Bearer header** and store `token` from the login body.
- JWT payload is `{ id }`, lifetime `JWT_EXPIRES_IN` default `30d` (`authController.js:161-165`, `backend/.env.example:23`).
- **Inactivity timeout** (server-side, returns 401 `TOKEN_INACTIVE_EXPIRED`): admin/super_admin 15 min, tutor 30 min, everyone else (incl. **parent**, which has no entry) 60 min (`middleware/auth.js:5-10, 14-16, 52-58`). Any authenticated call refreshes `lastActivityAt` (throttled to 60 s) **except** calls with header `X-BB-Passive: 1` (`middleware/auth.js:64-65`). The web sends that header only for `GET /api/notifications/badges`. CORS allows that header (`server.js:97`).
- Role check middleware `authorize(...)`: `super_admin` always passes; otherwise the role must be listed (`middleware/auth.js:88-99`).

### Envelope
Almost every endpoint returns JSON with a boolean `success`:
- Success: `{ "success": true, ...payload }` — the payload key differs per endpoint (`enrollments`, `schedules`, `remarks`, `announcements`, `badges`, `students`, `user`, …). There is **no generic `data` wrapper**.
- Failure: `{ "success": false, "message": "<human text>" }`, sometimes plus `code`, `errors`, `remark`.
- Exceptions: `GET /api/remarks/:id/attachment` returns **raw file bytes** on success (see §11).

### Common error responses (all protected endpoints)
| Status | When | Body | Source |
|---|---|---|---|
| 401 | no token | `{"success":false,"message":"Not authorized, no token"}` | `middleware/auth.js:32-35` |
| 401 | token valid but user deleted | `{"success":false,"message":"User not found"}` | `auth.js:41-45` |
| 401 | inactivity limit exceeded | `{"success":false,"message":"Session expired due to inactivity. Please log in again.","code":"TOKEN_INACTIVE_EXPIRED"}` (cookie is cleared) | `auth.js:52-59` |
| 401 | JWT expired | `{"success":false,"message":"Session expired. Please log in again.","code":"TOKEN_EXPIRED"}` | `auth.js:75-79` |
| 401 | JWT invalid/other | `{"success":false,"message":"Not authorized, token failed"}` | `auth.js:80-84` |
| 403 | role not allowed by `authorize()` | `{"success":false,"message":"User role tutor is not authorized to access this route"}` (role name interpolated) | `auth.js:94-98` |
| 404 | unknown route | `{"success":false,"message":"Route GET /api/x not found"}` | `server.js:200-206` |
| 429 | login rate limit | `{"success":false,"message":"Too many login attempts. Please try again in 15 minutes."}` | `middleware/rateLimit.js:26-29, 35-40` |
| 500 | thrown error in handler | `{"success":false,"message":"<err.message or default>"}` | each handler's `catch` |
| 500 | error escaping a handler | `{"success":false,"message":"Something went wrong!","error":"<only when NODE_ENV=development>"}` | `server.js:209-216` |

**Validation errors (400)** have two different shapes:
1. Routes wrapped in `validate([...])` (login, OTP, some payments) return express-validator format: `{"success":false,"message":"Validation failed","errors":[{"type":"field","value":"","msg":"Valid email is required","path":"email","location":"body"}]}` (`middleware/validate.js:19-23`).
2. Controller-level checks (enrollments, schedules, remarks, notifications) return `{"success":false,"message":"<one sentence>"}` (no `errors`). The **remarks** publish validation is the exception — see §9.

The web client only forces a logout on 401s that look like token/session failures (`frontend/src/services/api.ts:45-70`), not on every 401.

### IDs, dates, nulls
- Endpoints that use `.lean()` return Mongo ObjectIds as **24-char hex strings** and Dates as **ISO-8601 UTC strings** (`2026-09-24T08:58:50.226Z`). `_id` is on every document and sub-document that has one.
- A field marked `null` in a model default is serialised as `null`; a field with **no default** and never set is **missing** from the JSON (I mark those "may be missing").
- `populate()`d references become objects containing only the selected fields (plus `_id`); un-populated references stay as id strings. This differs per endpoint and is called out below.

---

## 1. Login and profile endpoints

**Which one returns the user's own name and role?** All of these:
- `POST /api/auth/login-start` (only when the device is trusted → OTP skipped) and `POST /api/auth/login-verify-otp` return `user` with `firstName`, `middleName`, `lastName`, `role` but **no combined `name` and no `phone`** (`authController.js:179-202`).
- `GET /api/auth/me` returns `user` with **all of the above plus a combined `name` and `phone`** (`authController.js:1188-1257`). The web builds its `User` from `/auth/me` and, on login, from the login response (`frontend/src/contexts/AuthContext.tsx:94-115`, `getMe` at `api.ts:203`, session restore `AuthContext.tsx:196-208`).

Parent and tutor login is a **two-step email-OTP flow**. The parent/tutor/student login page uses:

### 1a. `POST /api/auth/login-start`  (public, rate-limited 10 / 15 min)
- Route `backend/routes/authRoutes.js:90-99`; handler `authController.js:666-778`; web `api.ts:150-178`.
- Body: `email` (string, required, valid email, lower-cased), `password` (string, required), `role` (required, one of `"student" | "tutor" | "parent"`). `role: "admin"` is refused (400) — admins use `/api/auth/admin-login-start`.
- Success A (OTP needed, 200) — `authController.js:323-334`:
```json
{
  "success": true,
  "requiresOtp": true,
  "message": "Verification code sent to j***@example.com.",
  "verificationId": "6ab000000000000000000001",
  "maskedEmail": "j***@example.com",
  "expiresAt": "2026-09-25T08:10:00.000Z",
  "nextResendAvailableInSeconds": 180,
  "devOtp": "123456"
}
```
  `devOtp` is present **only** when email delivery failed and `NODE_ENV !== 'production'` (`authController.js:332, 386-410`). `nextResendAvailableInSeconds` is a number (0 when a resend is allowed).
- Success B (trusted device, 200) — same envelope as §1b (`requiresOtp:false`, `trustedDeviceBypass:true`, `token`, `user`) (`authController.js:762-770`, `246-253`).
- Errors (all `{success:false,...}`):
  - 400 `"Please provide email and password"`; 400 role admin: `"Admin login must use the admin login page at /admin-login"`; 400 validation → express-validator shape.
  - 401 `"Invalid credentials."` (unknown email, wrong password, or wrong role — deliberately identical); 401 `"Account is archived/suspended. Please contact admin."`; 401 `"Account is deactivated. Please contact support."` (non-student/parent inactive).
  - 403 with a `code`: `ENROLLMENT_PENDING_APPROVAL`, `ENROLLMENT_REJECTED` (`getEnrollmentLoginBlock`, `authController.js:109-128`), or `PASSWORD_EXPIRED` (`:753-758`). Body: `{"success":false,"code":"ENROLLMENT_PENDING_APPROVAL","message":"Enrollment is pending admin approval. You can log in once your account is approved."}`.
  - 429 OTP resend cooldown (`authController.js:353-368`): `{"success":false,"code":"OTP_RESEND_COOLDOWN","retryAfterSeconds":120,"verificationId":"…","maskedEmail":"…","expiresAt":"…","nextResendAvailableInSeconds":120,"message":"Please wait 2 minutes before sending another code."}`.
  - 503 `{"success":false,"code":"SYSTEM_MAINTENANCE","message":"Bee Bright is currently undergoing scheduled maintenance…"}` (students/tutors/parents only, `:729-737`).

### 1b. `POST /api/auth/login-verify-otp`  (public)
- Route `authRoutes.js:111-124`; handler `authController.js:893-1108`; web `api.ts:187-188`.
- Body: `email` (required), `verificationId` (required string), `otp` (required, exactly 6 numeric chars), `trustDevice` (optional boolean, default treated as **true** — `req.body?.trustDevice !== false`, `:1062`).
- Success 200 (`issueLoginSuccessResponse`, `authController.js:203-253`):
```json
{
  "success": true,
  "requiresOtp": false,
  "trustedDeviceBypass": false,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "6ab000000000000000000010",
    "firstName": "Pia",
    "middleName": "",
    "lastName": "Sample",
    "email": "pia.sample@example.com",
    "role": "parent",
    "isActive": true,
    "gradeLevel": null,
    "subjectsTaught": [],
    "employmentType": "full-time",
    "availability": "",
    "enrollmentStatus": "active",
    "paymentStatus": null,
    "profileImageUrl": null,
    "passwordChangedAt": "2026-09-01T00:00:00.000Z",
    "passwordExpiresAt": "2026-10-01T00:00:00.000Z",
    "passwordExpired": false,
    "passwordExpiresInDays": 5
  },
  "trustedDeviceRegistered": true,
  "trustedDeviceExpiresAt": "2026-10-25T08:00:00.000Z"
}
```
  - `role` values seen in code: `"student" | "tutor" | "parent" | "admin" | "super_admin"` (`frontend/src/contexts/AuthContext.tsx:11`).
  - `profileImageUrl` is a **full URL** (`http://host/uploads/avatars/<file>`) or `null` (`authController.js:76-80`).
  - `subjectsTaught` is `[]` for parents; for tutors it is populated `[{ "_id", "name", "code" }]`.
  - `trustedDeviceRegistered`/`trustedDeviceExpiresAt` (nullable) appear only on this endpoint (`:1062-1097`).
- Errors: 400 `"Email, verification session, and OTP are required."`, 400 `"That verification code has expired. Please send a new one."`, 400 `"Too many incorrect attempts. Please send a new verification code."`, 400 incorrect code (message includes attempts left), 404 `"Verification session not found. Please log in again."`, 401/403 same account-state messages as §1a (`:900-1057`). Validation 400 uses the express-validator shape.

### 1c. `GET /api/auth/me`  (auth required)
- Route `authRoutes.js:206`; handler `authController.js:1188-1257`.
- Success 200:
```json
{
  "success": true,
  "user": {
    "id": "6ab000000000000000000010",
    "firstName": "Pia",
    "middleName": "",
    "lastName": "Sample",
    "name": "Pia Sample",
    "email": "pia.sample@example.com",
    "role": "parent",
    "phone": "09171234567",
    "isActive": true,
    "gradeLevel": null,
    "guardianName": null,
    "guardianPhone": null,
    "enrolledSubjects": [],
    "subjectsTaught": [],
    "employmentType": "full-time",
    "availability": "",
    "enrollmentStatus": "active",
    "paymentStatus": null,
    "profileImageUrl": null,
    "lastLogin": "2026-09-25T00:00:00.000Z",
    "createdAt": "2026-09-01T00:00:00.000Z",
    "updatedAt": "2026-09-25T00:00:00.000Z",
    "passwordChangedAt": "2026-09-01T00:00:00.000Z",
    "passwordExpiresAt": "2026-10-01T00:00:00.000Z",
    "passwordExpired": false,
    "passwordExpiresInDays": 5
  }
}
```
  `gradeLevel`, `guardianName`, `guardianPhone`, `phone`, `enrollmentStatus`, `paymentStatus` come straight from the User document and **may be missing/undefined** when never set (no `|| null` guard at `:1214-1225`). `name` is `firstName middleName lastName` joined with spaces.
- Errors: 404 `{"success":false,"message":"User not found"}`; 403 with `code` `ENROLLMENT_PENDING_APPROVAL` / `ENROLLMENT_REJECTED`; common 401s.

### 1d. Other login endpoints (not needed for the app but present)
- `POST /api/auth/logout` (public; clears cookies, `authController.js:1126-`), `PUT /api/auth/update-profile` (`:1260`), `PUT /api/auth/profile-image` (own picture, `:1377`), `POST /api/auth/admin-login-start` / `admin-login-verify-otp` (admin only), legacy `POST /api/auth/login` and `POST /api/auth/login-complete` (`login-complete` always returns 410 `LOGIN_METHOD_UPDATED`, `authController.js:1115-1120`). I did not document their bodies.

---

## 2. `GET /api/enrollments/my-enrollments`

- Auth: any logged-in user (route `backend/routes/enrollmentRoutes.js:49`, `protect` only). Handler `backend/controllers/enrollmentController.js:860-882`. Web: `api.ts:381`, used by `frontend/src/contexts/SelectedChildContext.tsx:78`.
- Query: none.
- Returns every enrollment where `parent == me` **or** `student == me`, newest first, each with a `payments[]` array attached (`:862-877`).
- Envelope: `{ "success": true, "enrollments": [ Enrollment ] }`. Empty account → `"enrollments": []` (not an error).
- The enrollment is returned **whole** (`.lean()`, no field filtering), so every field of `backend/models/Enrollment.js` is present. Field reference (types and nullability from the model; `?` = may be missing because it has no default):

| Field | Type | Notes / source |
|---|---|---|
| `_id` | string | |
| `enrollmentId` | string \| missing | `BB-YYYYMMDD-NNNN`, per-enrollment application id (`Enrollment.js:21`). **Internal key** for payment-proof routes; don't display. |
| `parent` | string (id) \| null | not populated |
| `student` | string (id) \| null | the child's User `_id`; `null` until a class is first scheduled for them (`Enrollment.js:36`) |
| `studentSnapshot` | object | `{ firstName:"", lastName:"", middleName:"", birthdate: ISO\|null, computedAge: number\|null }` (`Enrollment.js:44-50`) |
| `packages[]` | array | `{ programCode, packageSlug, displayName, price:number, paymentOption:"full"\|"down" }`, no `_id` (`Enrollment.js:11-17`) |
| `subject`, `selectedSubjects[]` | id \| null, id[] | legacy refs, not populated |
| `preferredStartDate` | ISO \| null | |
| `preferredTime` | `"morning"\|"afternoon"\|"no_preference"\|null` | |
| `preferredDays` | string[] | `Monday..Saturday` |
| `preferredDaysByProgram` | `[{programCode, days[]}]` | |
| `preferredSlots` | `[{programCode, startTime, endTime}]` | `"HH:MM"` strings |
| `healthInfo` | object | `{allergies:"", medications:"", specialNeeds:false, specialNeedsDetails:"", emergencyContact:""}` |
| `requirementDocuments` | object | `{birthCertificate, studentPhoto, guardianId}`, each `{ path: string\|null, fileName: string\|null, uploadedAt: ISO\|null }` (`Enrollment.js:132-136`). **`path` is a server-relative URL path** like `/uploads/requirements/student-photo-BB-…-<ts>-<hex>.jpg` (`enrollmentController.js:84`). |
| `referenceNumber` | string \| null | legacy, normally `null` |
| `paymentOption` | `"full"\|"down"` | default `"full"`; wizard always sets `"down"` |
| `totalFee` | number | full price of all packages (PHP) |
| `status` | enum | see §C |
| `paymentStatus` | enum | see §C |
| `consentVersion` / `consentAcceptedAt` / `consentItems[]` | string\|null / ISO\|null / `[{name, accepted, version?}]` | |
| `rejectionReason` | string \| null | |
| `allowResubmission` | boolean | |
| `statusHistory[]` | `[{status, at, by, byRole, note}]` | no `_id` |
| `enrollmentDate` | ISO | |
| `startDate`, `endDate`, `paymentVerifiedAt` | ISO \| missing | |
| `approvedAt` | ISO \| null | |
| `approvedBy` | `{_id, firstName, lastName}` \| null | **populated** (`:866`) |
| `verifiedBy` | string \| null | not populated |
| `studentId` | string \| null | shown Student ID. Equals `permanentStudentId` for enrollments approved/created after the permanent-ID change; old approved rows may hold the legacy `S-YYYYMMDD-NNNN` (`Enrollment.js:200-203`) |
| **`permanentStudentId`** | string \| null | The child's permanent Student ID = first enrollment's `BB-…` (`Enrollment.js:209`). Legacy rows can be `null` until the startup backfill has run (`backend/utils/studentIdentity.js`, called at `server.js:151`). **Group children by this** (fallback `_id`). |
| `renewalOf` | string \| null | id of the enrollment that was renewed |
| **`studentProfileImage`** | string \| null | server-relative path `/uploads/student-avatars/<file>`, same value on every enrollment of the child (`enrollmentController.js:489-491`) |
| `preEnrollmentAssessment` | object | `{applicable:boolean\|null, skipReason, templateId, templateSlug, templateTitle, snapshot, infoValues, ratings, remarks:"", goals:[{goal,timeline}], assessedBy:"", completedAt: ISO\|null}` (`Enrollment.js:218-235`). Skipped assessments still get `completedAt`; only `applicable:true` is a real assessment. |
| `createdAt`, `updatedAt` | ISO | |
| `payments[]` | array | see below |

`payments[]` items (selected fields only, `enrollmentController.js:873`; newest first):

| Field | Type | Notes |
|---|---|---|
| `_id` | string | |
| `status` | enum | §C |
| `paymentType` | `"full"\|"down"\|"remaining"` | `Payment.js:70-74` |
| `amount` | number | |
| `amountDue` | number \| null | server-computed (down = `ceil(full*0.5)`) |
| `amountPaid` | number \| null | set when verified |
| `paymentMethod` | enum | §C |
| `proofUrl` | string \| null | relative path `/uploads/payments/proof-…` (§E) |
| `submittedAt` | ISO \| null | |
| `verifiedAt` | ISO \| missing | `Payment.js:135` no default |
| `rejectionReason` | string \| null | |
| `referenceNumber` | string | auto `BB<yyyy><mm><6-digit>` per payment (`Payment.js:147-156`); may be missing on very old rows |
| `resubmissionCount` | number | |

Sample (one enrollment; a renewal of a child who already had `BB-20260901-0001`):
```json
{
  "success": true,
  "enrollments": [
    {
      "_id": "6ab100000000000000000002",
      "enrollmentId": "BB-20260920-0002",
      "parent": "6ab000000000000000000010",
      "student": "6ab000000000000000000020",
      "studentSnapshot": { "firstName": "Lia", "lastName": "Sample", "middleName": "", "birthdate": "2018-03-04T00:00:00.000Z", "computedAge": 8.5 },
      "packages": [
        { "programCode": "ACT102", "packageSlug": "premier-elementary", "displayName": "Academic Tutorial – Premier (Pre-School / Elementary)", "price": 2400, "paymentOption": "down" }
      ],
      "subject": null,
      "selectedSubjects": [],
      "preferredStartDate": "2026-10-01T00:00:00.000Z",
      "preferredTime": null,
      "preferredDays": ["Monday", "Wednesday"],
      "preferredDaysByProgram": [{ "programCode": "ACT102", "days": ["Monday", "Wednesday"] }],
      "preferredSlots": [{ "programCode": "ACT102", "startTime": "09:00", "endTime": "10:00" }],
      "healthInfo": { "allergies": "None", "medications": "None", "specialNeeds": false, "specialNeedsDetails": "", "emergencyContact": "09171234567" },
      "requirementDocuments": {
        "birthCertificate": { "path": "/uploads/requirements/birth-certificate-BB-20260901-0001-1789000000000-ab12cd34.jpg", "fileName": "birth.jpg", "uploadedAt": "2026-09-01T02:00:00.000Z" },
        "studentPhoto": { "path": "/uploads/requirements/student-photo-BB-20260901-0001-1789000000001-ab12cd35.jpg", "fileName": "photo.jpg", "uploadedAt": "2026-09-01T02:00:00.000Z" },
        "guardianId": { "path": null, "fileName": null, "uploadedAt": null }
      },
      "referenceNumber": null,
      "paymentOption": "down",
      "totalFee": 2400,
      "status": "approved",
      "paymentStatus": "partial",
      "consentVersion": "1.0",
      "consentAcceptedAt": "2026-09-20T01:00:00.000Z",
      "consentItems": [{ "name": "participation_agreement", "accepted": true, "version": "1.0" }],
      "rejectionReason": null,
      "allowResubmission": false,
      "statusHistory": [{ "status": "submitted", "at": "2026-09-20T01:00:00.000Z", "by": "6ab000000000000000000010", "byRole": "parent", "note": "Enrollment wizard submitted" }],
      "enrollmentDate": "2026-09-20T01:00:00.000Z",
      "approvedAt": "2026-09-21T03:00:00.000Z",
      "approvedBy": { "_id": "6ab000000000000000000099", "firstName": "Ana", "lastName": "Admin" },
      "verifiedBy": null,
      "studentId": "BB-20260901-0001",
      "permanentStudentId": "BB-20260901-0001",
      "renewalOf": "6ab100000000000000000001",
      "studentProfileImage": "/uploads/student-avatars/BB-20260901-0001-1789000000002-a1b2c3.png",
      "preEnrollmentAssessment": { "applicable": false, "skipReason": "Not applicable", "templateId": null, "templateSlug": null, "templateTitle": null, "snapshot": null, "infoValues": {}, "ratings": {}, "remarks": "", "goals": [], "assessedBy": "", "completedAt": "2026-09-20T01:00:00.000Z" },
      "createdAt": "2026-09-20T01:00:00.000Z",
      "updatedAt": "2026-09-21T03:00:00.000Z",
      "payments": [
        { "_id": "6ab200000000000000000003", "status": "verified", "paymentType": "down", "amount": 1200, "amountDue": 1200, "amountPaid": 1200, "paymentMethod": "gcash", "proofUrl": "/uploads/payments/proof-6ab100000000000000000002-1789000000003-ab12cd36.jpg", "submittedAt": "2026-09-20T01:05:00.000Z", "verifiedAt": "2026-09-21T02:00:00.000Z", "rejectionReason": null, "referenceNumber": "BB202609000042", "resubmissionCount": 0 }
      ]
    }
  ]
}
```
- Errors: common 401s; 500 `{"success":false,"message":"Failed to fetch enrollments."}` (or `err.message`).
- **Child list logic** used by the web (so the Android app can copy it): `frontend/src/lib/children.ts:26-53` groups the array (newest first) by `permanentStudentId || _id`; the first (newest) enrollment supplies name/status, `student` is taken from the first enrollment that has one, photo = `studentProfileImage || requirementDocuments.studentPhoto.path`.

---

## 3. `GET /api/schedules/student/my-classes?studentId=`

- Auth: `protect` + `authorize('student','parent')` (`backend/routes/scheduleRoutes.js:59`). Handler `backend/controllers/scheduleController.js:2495-2530`. Web: `api.ts:749`, consumed at `frontend/src/pages/StudentDashboard.tsx:349`.
- Query: `studentId` — child's **User `_id`** (= enrollment `student`, **not** the permanent Student ID). **Required for a parent**; ignored for a student account (uses own id).
- Ownership: parent must have a non-cancelled/rejected/draft enrollment with `student == studentId` (`backend/utils/parentChildAccess.js:14-22`).
- Success 200 (`:2527-2531`): `{ "success": true, "count": <int>, "schedules": [ Schedule ] }`, sorted by `date` then `startTime`, then de-duplicated (`dedupeSchedulesForResponse`, `:59-100`: key = student+subject+date+start+end, keeps the copy with attendance marked).
- `Schedule` items have **these populated** (`:2517-2523`): `tutor` and `tutors[]` → `{_id, firstName, lastName, middleName?, email, phone?, profileImage?}`; `student` and `students[]` → `{_id, firstName, lastName, middleName?, email, profileImage?}`; `subject` → `{_id, name, code}`. All other fields are raw (`backend/models/Schedule.js`):

| Field | Type | Notes |
|---|---|---|
| `_id` | string | |
| `sessionType` | `"one-on-one"\|"small-group"\|"playgroup"` | default `"one-on-one"` (`Schedule.js:7-11`) |
| `student` | object \| null | one-on-one child |
| `students[]` | object[] | group roster; `[]` for one-on-one |
| `maxCapacity` | number | 1 / 3 / 12 by type (`backend/utils/sessionTypeManager.js:12-24`) |
| `tutor` | object | lead tutor |
| `tutors[]` | object[] | co-tutors (playgroup) |
| `subject` | `{_id,name,code}` | the **program** (`Toddlers Playgroup` / `Academic Tutorial` / `Examination Preparation`, codes `TPG101/ACT102/EXP106`) |
| `date` | ISO string | UTC midnight of the session day (§D) |
| `startTime`, `endTime` | string `"HH:MM"` 24-hour | no timezone |
| `attendanceStatus` | `"unmarked"\|"present"\|"absent"` | default `"unmarked"` |
| `attendanceMarkedAt` | ISO \| null | |
| `originalTutor`, `substituteTutor`, `substitutedBy` | id \| null | substitution bookkeeping |
| `isSubstitution` | boolean | |
| `substitutionReason` | string | `''` default |
| `substitutedAt`, `substitutionTimestamp` | ISO \| null | |
| `substitutionStatus` | `"none"\|"in_progress"\|"assigned"\|"substitute_required"` | |
| `substitutionRequestSource` | `"none"\|"tutor_announcement"\|"admin_marked_absent"\|"attendance_timeout"\|"manual_assignment"` | |
| `substitutionAttemptCount` | number | |
| `tutoringAreaId` | id \| null | room |
| `weeklyScheduleTemplateEntryId` | id \| null | |
| `dayOfWeek` | number 0-5 \| null | |
| `sessionSource` | `"manual"\|"template_generated"` | |
| `isEnrollableByStudents` | boolean | |
| `group` | id \| null | playgroup roster id |
| `createdAt`, `updatedAt` | ISO | |

**There is no session-number / "session x of y" field anywhere** (NOT FOUND in `Schedule.js`, controllers or web code).

Sample:
```json
{
  "success": true,
  "count": 1,
  "schedules": [
    {
      "_id": "6ab300000000000000000005",
      "sessionType": "one-on-one",
      "student": { "_id": "6ab000000000000000000020", "firstName": "Lia", "lastName": "Sample", "middleName": "", "email": "child.6ab100000000000000000002@students.beebright.internal", "profileImage": null },
      "students": [],
      "maxCapacity": 1,
      "tutor": { "_id": "6ab000000000000000000030", "firstName": "Tess", "lastName": "Tutor", "middleName": "", "email": "tess.tutor@example.com", "phone": "09170000000", "profileImage": null },
      "tutors": [],
      "isSubstitution": false,
      "substitutionReason": "",
      "substitutionStatus": "none",
      "substitutionRequestSource": "none",
      "substitutionAttemptCount": 0,
      "originalTutor": null, "substituteTutor": null, "substitutedBy": null, "substitutedAt": null, "substitutionTimestamp": null,
      "subject": { "_id": "6ab400000000000000000001", "name": "Academic Tutorial", "code": "ACT102" },
      "date": "2026-09-28T00:00:00.000Z",
      "startTime": "09:00",
      "endTime": "10:00",
      "attendanceStatus": "unmarked",
      "attendanceMarkedAt": null,
      "tutoringAreaId": null,
      "weeklyScheduleTemplateEntryId": null,
      "dayOfWeek": null,
      "sessionSource": "manual",
      "isEnrollableByStudents": false,
      "group": null,
      "createdAt": "2026-09-24T05:00:00.000Z",
      "updatedAt": "2026-09-24T05:00:00.000Z"
    }
  ]
}
```
- Errors:
  - 403 parent without/with someone else's `studentId`: `{"success":false,"message":"Select one of your own children to view their classes."}` (`:2499-2505`). A missing `studentId` gives the **same 403**, not 400.
  - 403 tutor/admin (route level): `User role tutor is not authorized to access this route`; non-student/parent that reaches the controller: `"Only students and parents can access my classes"`.
  - 500 `"Failed to fetch classes"`.
- A child with `student == null` (nothing scheduled yet) has no User id to pass; the web then skips this call and shows an empty schedule (`StudentDashboard.tsx:341-350`).

---

## 4. `GET /api/schedules/my-sessions`  (tutor)

- Route `scheduleRoutes.js:57` (`protect` only; role checked in handler). Handler `scheduleController.js:2352-2380`. Web `api.ts:745`, consumed at `frontend/src/pages/TutorDashboard.tsx:280-289`.
- Query: none. Returns every schedule where the caller is `tutor` **or** in `tutors[]` (all dates, sorted by `date`, `startTime`), de-duplicated the same way as §3.
- Success 200: `{ "success": true, "count": <int>, "schedules": [ Schedule ] }`.
- Populated differently from §3 (`:2360-2364`): `student` and `students[]` → `{_id, firstName, lastName, middleName?, email, gradeLevel?, phone?, profileImage?}`; `tutors[]` → `{_id, firstName, lastName, middleName?, email, profileImage?}`; `subject` → `{_id,name,code}`. **`tutor` (the lead tutor) is NOT populated here — it is an id string.** `profileImage` on these user objects is a relative storage path like `avatars/<userId>-<ts>.jpg` (no `/uploads/` prefix, §E).
- Sample: same as §3 with `tutor` as `"6ab000000000000000000030"` and a playgroup example:
```json
{
  "_id": "6ab300000000000000000006",
  "sessionType": "playgroup",
  "student": null,
  "students": [
    { "_id": "6ab000000000000000000020", "firstName": "Lia", "lastName": "Sample", "email": "child.a@students.beebright.internal", "gradeLevel": null, "phone": "09000000000", "profileImage": null },
    { "_id": "6ab000000000000000000021", "firstName": "Bo", "lastName": "Sample", "email": "child.b@students.beebright.internal", "profileImage": null }
  ],
  "maxCapacity": 12,
  "tutor": "6ab000000000000000000030",
  "tutors": [{ "_id": "6ab000000000000000000030", "firstName": "Tess", "lastName": "Tutor", "email": "tess.tutor@example.com", "profileImage": null }],
  "subject": { "_id": "6ab400000000000000000002", "name": "Toddlers Playgroup", "code": "TPG101" },
  "date": "2026-09-28T00:00:00.000Z", "startTime": "09:00", "endTime": "11:00",
  "attendanceStatus": "unmarked", "attendanceMarkedAt": null, "group": "6ab500000000000000000001"
}
```
- Errors: 403 `{"success":false,"message":"Only tutors can access my sessions"}` for non-tutors (`:2354-2359`); 500 `"Failed to fetch sessions"`. Admin/super_admin get the 403 too (handler check, not route).
- Attendance is per Schedule document, so a playgroup session has **one** `attendanceStatus` for the whole group (no per-child attendance exists — NOT FOUND).

---

## 5. `GET /api/schedules/my-students`  (tutor "My Students" cards)

- Route `scheduleRoutes.js:58`; handler `scheduleController.js:2416-2493`; web `api.ts:747` (`TutorStudentCard` type at `api.ts:859`), consumed in `TutorDashboard.tsx` (fetch effect near `:299-306`).
- Query: none. Tutor only.
- Success 200: `{ "success": true, "students": [ { studentUserId, name, programs, studentId, schedule } ] }`, sorted by `name`.

| Field | Type | Notes |
|---|---|---|
| `studentUserId` | string | child's User `_id` |
| `name` | string | `firstName lastName`; `"Student"` if both empty |
| `programs` | string[] | package `displayName`s **for programs this tutor teaches this child**; falls back to the subject names if no package matches |
| `studentId` | string \| null | permanent Student ID (`permanentStudentId`, else the enrollment's `enrollmentId`); `null` if the child has no non-cancelled enrollment |
| `schedule` | string | `"Mon/Tue/Wed, 9:00–10:00 AM"`; several time groups joined with `" • "`; `""` when nothing; built from UTC weekday of `date` (upcoming sessions, else all) |

```json
{ "success": true, "students": [
  { "studentUserId": "6ab000000000000000000020", "name": "Lia Sample",
    "programs": ["Academic Tutorial – Prestige (Junior / Senior High School)"],
    "studentId": "BB-20260901-0001", "schedule": "Mon/Tue/Wed, 9:00–10:00 AM" } ] }
```
- Duplicated student Users of the same child collapse into one card keyed by `studentId`.
- Errors: 403 `{"success":false,"message":"Only tutors can access their students"}`; 500 `"Failed to fetch students"`. A tutor with no schedules gets `{"success":true,"students":[]}`.

---

## 6. `PATCH /api/schedules/:id/attendance`  (tutor)

- Route `scheduleRoutes.js:60` (`protect`; role checked in handler). Handler `scheduleController.js:2545-2646`. Web `api.ts:750`, called from `frontend/src/components/tutor/AttendanceTab.tsx:148` and `TutorDashboard.tsx:1221`.
- Path: `:id` = Schedule `_id`. Body: `{ "status": "present" | "absent" }` (required; `"unmarked"` cannot be sent).
- Rules: caller must be a tutor and `tutor` or in `tutors[]` of that schedule; session date (UTC day) must be **today or earlier** (`:2569-2579`). Marking `present` on **today's** session also flips that student's earlier `unmarked` sessions of the same subject to `present` (`:2587-2605`).
- Success 200:
```json
{
  "success": true,
  "message": "Attendance marked as present (also auto-marked 2 past sessions as present)",
  "autoMarkedPastSessions": 2,
  "schedule": {
    "_id": "6ab300000000000000000005",
    "student": { "_id": "6ab000000000000000000020", "firstName": "Lia", "lastName": "Sample", "middleName": "" },
    "subject": { "_id": "6ab400000000000000000001", "name": "Academic Tutorial", "code": "ACT102" },
    "tutor": "6ab000000000000000000030",
    "date": "2026-09-24T00:00:00.000Z", "startTime": "09:00", "endTime": "10:00",
    "attendanceStatus": "present", "attendanceMarkedAt": "2026-09-24T02:15:00.000Z"
  }
}
```
  (`schedule` is the full lean document with only `student` and `subject` populated; only the key fields are shown. The message suffix appears only when `autoMarkedPastSessions > 0`.)
- Errors: 403 `{"success":false,"message":"Only tutors can mark attendance for their sessions"}`; 400 `'status must be "present" or "absent"'`; 404 `"Session not found or you are not the tutor for this session"`; 400 `"You can only mark attendance for today or past sessions."`; 500 `"Failed to mark attendance"`.
- The web asks for confirmation before flipping an already-marked status; **the server does not enforce that** (client-only, `AttendanceTab.tsx:166-183`).

---

## 7. `GET /api/remarks/my-progress`  (parent / student)

- Route `backend/routes/remarkRoutes.js:21` (whole router is `protect`, `:17`). Handler `remarkController.js:433-470`. Web `api.ts:1002-1003`, called at `StudentDashboard.tsx:291`.
- Query params (all optional except `studentId` for parents):

| Param | Type | Behaviour |
|---|---|---|
| `studentId` | string (child User id) | **required for a parent**; ignored for a student |
| `tutorId` | string | filter `tutor` |
| `programCode` | `TPG101\|ACT102\|EXP106` | filter |
| `activity` | string | case-insensitive regex match against `activities[]` (**not escaped** — treat as regex) |
| `startDate`, `endDate` | date string parsed with `new Date()` | filter `date` `>=` / `<=`; either may be given alone |

  The web only ever passes `studentId`; program/tutor/activity filtering is done client-side (`StudentDashboard.tsx` `filteredProgressRemarks`). NOT FOUND: any web call using the other params.
- Returns only `status:"published"` and `isCurrentVersion:true`, sorted `publishedAt` desc (`:449-465`). Drafts and pending remarks are never returned.
- Success 200: `{ "success": true, "remarks": [ Remark ] }`. In this endpoint `tutor` is **populated** to `{ _id, firstName, lastName }`; `student` and `reviewedBy` are plain id strings/null.
- `Remark` fields (`backend/models/Remark.js`; nested objects always exist with defaults — verified by instantiating the model):

| Field | Type | Notes |
|---|---|---|
| `_id` | string | |
| `student` | string (id) \| object | id here; `{_id,firstName,lastName,middleName}` in tutor endpoints |
| `tutor` | string \| `{_id,firstName,lastName}` | object here |
| `programCode` | `"TPG101"\|"ACT102"\|"EXP106"` | |
| `templateType` | `"toddler_observation"\|"academic_progress"\|"examination_progress"` | derived from `programCode` |
| `date` | ISO | |
| `activities` | string[] | each ≤ 200 chars |
| `ratings` | `{participationEngagement, socialInteraction, followingDirections, overallBehavior}` | each `1\|2\|3\|null`; **only meaningful for TPG101**, `null`s otherwise |
| `remarkBullets` | string[] | each ≤ 500 |
| `nextFocus` | string | `""` if empty |
| `parentSupportSuggestion` | string | `""` if empty (used by ACT102) |
| `examInfo` | `{topic, scoreResult, mistakesToReview, studyGoal}` | strings, `""` default (used by EXP106; `scoreResult` ≤ 40) |
| `attachment` | `{path, fileName, mimetype, size, uploadedAt}` | **always an object**; when there is no file every field is `null`. Check `attachment.path != null`. `path` is the private disk filename (`remark-<ts>-<hex>.png`), **not a URL** — fetch via §11. |
| `status` | `"draft"\|"pending_admin_review"\|"published"` | |
| `publishedAt` | ISO \| null | set on admin approval |
| `rootRemarkId`, `correctionOf` | id \| null | legacy, always null for new remarks |
| `correctionReason` | string | `""` |
| `isCurrentVersion` | boolean | true |
| `reviewedBy` | id \| null | not populated in this endpoint |
| `reviewedAt` | ISO \| null | |
| `rejectionReason` | string | `""` unless rejected |
| `createdAt`, `updatedAt` | ISO | |

Sample (a toddler remark):
```json
{
  "success": true,
  "remarks": [
    {
      "_id": "6ab600000000000000000007",
      "student": "6ab000000000000000000020",
      "tutor": { "_id": "6ab000000000000000000030", "firstName": "Tess", "lastName": "Tutor" },
      "programCode": "TPG101",
      "templateType": "toddler_observation",
      "date": "2026-09-24T00:00:00.000Z",
      "activities": ["Color matching", "Songs"],
      "ratings": { "participationEngagement": 3, "socialInteraction": 2, "followingDirections": 3, "overallBehavior": 3 },
      "remarkBullets": ["The student showed improvement in sharing."],
      "nextFocus": "Next session, we will practice counting to 5.",
      "parentSupportSuggestion": "",
      "examInfo": { "topic": "", "scoreResult": "", "mistakesToReview": "", "studyGoal": "" },
      "attachment": { "path": null, "fileName": null, "mimetype": null, "size": null, "uploadedAt": null },
      "status": "published",
      "publishedAt": "2026-09-24T06:00:00.000Z",
      "rootRemarkId": null, "correctionOf": null, "correctionReason": "", "isCurrentVersion": true,
      "reviewedBy": "6ab000000000000000000099", "reviewedAt": "2026-09-24T06:00:00.000Z", "rejectionReason": "",
      "createdAt": "2026-09-24T02:00:00.000Z", "updatedAt": "2026-09-24T06:00:00.000Z"
    }
  ]
}
```
- Errors: 403 `{"success":false,"message":"Select one of your own children to view their progress."}` (missing or foreign `studentId`); 403 `"Only students and parents can view progress"` (tutor/admin reaching the handler); 500 `"Failed to fetch progress"`. Note: a **bad (non-ObjectId) `studentId`** would raise a Mongoose CastError inside `parentOwnsStudent` → 500 with the cast message (no format check, unlike announcements) — inferred from code, not exercised.

---

## 8. `GET /api/remarks/mine`  (tutor)

- Route `remarkRoutes.js:20`; handler `remarkController.js:410-425`; web `api.ts:999-1000`, called at `TutorDashboard.tsx:761`.
- Query: `studentId` (optional, child User id).
- Success 200: `{ "success": true, "remarks": [ Remark ] }` — **all statuses** (draft, pending_admin_review, published) authored by the caller, newest `createdAt` first. Here `student` is **populated** `{ _id, firstName, lastName, middleName }`; `tutor` and `reviewedBy` are id strings. Otherwise identical to the §7 table. Rejected remarks come back as `status:"draft"` with `rejectionReason` filled (`reviewRemark` resets to draft).
- Errors: 403 `{"success":false,"message":"Only tutors can list their remarks"}`; 500 `"Failed to fetch remarks"`.

---

## 9. `POST /api/remarks`, `PUT /api/remarks/:id`, `DELETE /api/remarks/:id`  (tutor)

### 9a. Which programs/students a tutor may write for (rule enforced by the server)
`tutorHandlesStudentForProgram` (`remarkController.js:38-49`): there must be at least one Schedule where the caller is `tutor`/in `tutors[]` **and** the student is `student`/in `students[]`, whose `subject` resolves (`backend/utils/schedulingPolicy.js:88-93`, by `subject.code` or name substring) to the requested `programCode`. Program → template: `TPG101→toddler_observation`, `ACT102→academic_progress`, `EXP106→examination_progress` (`remarkController.js:21-25`). See answer **B** for how the web builds the picker.

### 9b. `POST /api/remarks` — create draft or submit
- Handler `remarkController.js:138-262`. Web: `frontend/src/components/tutor/RemarkForm.tsx:183` via `api.ts:992-993`; payload type `RemarkFormPayload` at `api.ts:957-969`.
- Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `studentId` | string (child User id) | yes | |
| `programCode` | `TPG101\|ACT102\|EXP106` | yes | |
| `action` | `"draft"\|"publish"` | yes | `"publish"` = submit for admin review (nothing goes live until approved) |
| `date` | string parsable by `new Date` | no | defaults to now (web sends `YYYY-MM-DD`) |
| `activities` | string[] | for publish | trimmed, blanks dropped |
| `remarkBullets` | string[] | for publish | |
| `nextFocus` | string | for publish | |
| `ratings` | `{participationEngagement, socialInteraction, followingDirections, overallBehavior}` each 1-3 | **TPG101 publish only** | out-of-range values become `null` |
| `parentSupportSuggestion` | string | optional (ACT102 in the web form) | |
| `examInfo` | `{topic, scoreResult, mistakesToReview, studyGoal}` | optional (EXP106 in the web form) | `scoreResult` must match `18/20` or `85%` (or `12.5%`) when provided (`remarkController.js:28`) |
| `attachmentDataUrl` | string `data:image/png\|jpeg\|jpg\|application/pdf;base64,…` | optional | ≤ 5 MB |
| `attachmentFileName` | string | optional | display name |

- **Fields that differ per program** (the server accepts the same JSON keys for all; what is *validated* differs):
  - **TPG101** (toddler observation): common fields + **four star ratings 1–3, all required to publish**. Web labels: Participation and Engagement, Social Interaction, Following Directions, Overall Behavior (`RemarkForm.tsx:291-302`).
  - **ACT102** (academic progress): common fields + optional `parentSupportSuggestion`.
  - **EXP106** (examination progress): common fields + optional `examInfo` (topic, score/result, mistakes/concepts to review, study goal).
  - Common to all: `date`, `activities`, `remarkBullets`, `nextFocus`, optional attachment.
  - Server does **not** reject extra keys (e.g. `ratings` sent for ACT102 is stored).
- Success — draft (201): `{"success":true,"message":"Draft saved.","remark":{Remark}}`.
- Success — submit (201): `{"success":true,"message":"Remark submitted for admin review.","remark":{Remark}}` with `status:"pending_admin_review"`, `publishedAt:null`.
- `remark` here is populated: `student` → `{_id,firstName,lastName,middleName}`, `tutor` → `{_id,firstName,lastName}`, `reviewedBy` → `{...}` or `null` (`populateRemark`, `:124-130`).
- Sample request (ACT102 submit):
```json
{ "studentId": "6ab000000000000000000020", "programCode": "ACT102", "action": "publish",
  "date": "2026-09-24", "activities": ["Fractions worksheet"],
  "remarkBullets": ["The student participated well in guided practice."],
  "nextFocus": "Next session, we will review decimals.",
  "parentSupportSuggestion": "Practice 10 minutes of fractions at home." }
```
- **Field-error format when validation fails** (publish only, `remarkController.js:81-101, 214-227`): HTTP **400**, a **flat array of sentences in `errors`** — *not* keyed by field name — plus the saved draft:
```json
{
  "success": false,
  "message": "Please correct the highlighted fields before publishing.",
  "errors": [
    "At least one activity is required.",
    "At least one remark bullet is required.",
    "Next Focus is required.",
    "All four rating categories need a 1-3 star rating."
  ],
  "remark": { "_id": "6ab600000000000000000008", "status": "draft", "…": "…" }
}
```
  The complete set of possible strings: `A valid date is required.` · `At least one activity is required.` · `At least one remark bullet is required.` · `Next Focus is required.` · `All four rating categories need a 1-3 star rating.` (TPG101) · `Score/result must be in the format "18/20" or "85%".` (EXP106) · attachment errors `Attachment must be a JPG, PNG, or PDF.` / `Attachment file is empty.` / `Attachment file must be 5 MB or less.`. **A failed publish still creates a draft** (returned in `remark`) — the client must switch to `PUT` with that `_id` rather than POSTing again (the web does this: `RemarkForm.tsx:170-190`).
- Draft with a bad attachment (400): `{"success":false,"message":"The attachment could not be saved.","errors":["Attachment file must be 5 MB or less."]}` and nothing is saved. Drafts skip all other validation.
- Other errors: 403 `"Only tutors can create remarks"`; 400 `"studentId is required"`; 400 `"A valid programCode (remark type) is required"`; 400 `"action must be 'draft' or 'publish'"`; **403 `"You are not assigned to teach this student in that program"`**; 500 `"Failed to save remark"`.

### 9c. `PUT /api/remarks/:id` — resave/submit an existing draft
- Handler `remarkController.js:265-360`; web `RemarkForm.tsx:180` (`api.ts:994-995`, payload = `RemarkFormPayload` without `studentId`; `programCode` is not read).
- Only the tutor's own remark with `status:"draft"` (rejected remarks are drafts too). Body: `action` (required), `date`, `activities`, `ratings`, `remarkBullets`, `nextFocus`, `parentSupportSuggestion`, `examInfo`, `attachmentDataUrl`, `attachmentFileName`. **Omitting `attachmentDataUrl` keeps the existing attachment.** All list/text fields are overwritten with what you send (send everything).
- Success 200: `{"success":true,"message":"Draft saved.","remark":{…}}` for `action:"draft"`, or `"Remark submitted for admin review."` for `publish` (status → `pending_admin_review`).
- Validation failure for `publish`: same 400 + `errors[]` + `remark` shape as §9b (draft is saved).
- Errors: 403 `"Only tutors can edit remarks"`; 404 `"Remark not found or you cannot edit it"`; 400 `"Only drafts can be edited here. Use Correct Published Remark for a published remark."` (the text mentions a feature that no longer exists — quoted verbatim); 400 `"action must be 'draft' or 'publish'"`; 500 `"Failed to update remark"`.

### 9d. `DELETE /api/remarks/:id` — delete a draft
- Handler `remarkController.js:365-406`; web `RemarkForm.tsx:235`, `api.ts:997-998`. No body.
- Success 200: `{"success":true,"message":"Draft deleted."}` (also deletes the stored attachment file).
- Errors: 403 `"Only tutors can delete their remarks"`; 404 `"Remark not found or you cannot delete it"`; 400 `"Only drafts can be deleted. A published remark is permanent and cannot be deleted."` (also applies to `pending_admin_review`); 500 `"Failed to delete draft"`.

---

## 10. Remark review is admin-only (context)
Submitted remarks go to `pending_admin_review`; `PATCH /api/remarks/:id/review` (`admin` only, `remarkRoutes.js:28`) approves (→ `published`) or rejects (→ back to `draft` with `rejectionReason`). Not needed by the Android parent/tutor app.

---

## 11. `GET /api/remarks/:id/attachment`

- Route `remarkRoutes.js:30`; handler `remarkController.js:664-693`; web `api.ts:1013-1016` (`getAttachmentObjectUrl`, fetches as `responseType:'blob'` and makes an object URL), used at `StudentDashboard.tsx:309`, `RemarkDetailDialog.tsx:41`, `RemarksReviewQueue.tsx:59`.
- **Auth required — the header/cookie must be sent with the file request**; a bare image URL will 401. Files live in `backend/private-uploads/remarks/`, deliberately **not** under the public `/uploads` mount (`remarkController.js:16`).
- Success 200: **raw bytes** (not JSON). Headers: `Content-Type` = stored mimetype (`image/png`, `image/jpeg`, or `application/pdf`; fallback `application/octet-stream`); `Content-Disposition: inline; filename="<fileName>"`.
- Access: admin/super_admin; the authoring tutor; the student; or the parent of that student. Students/parents only for `status === "published"`.
- Errors (JSON): 404 `{"success":false,"message":"Attachment not found"}` (no such remark / no attachment); 403 `"Not authorized to view this attachment"`; 403 `"This remark is not yet published."`; 404 `"Attachment file missing"`; 500 `"Failed to load attachment"`.

---

## 12. `GET /api/announcements/student?studentId=`

- Route `backend/routes/announcementRoutes.js:16-18` (`protect` + `authorize('student','parent')`); handler `announcementController.js:138-180`; web `api.ts:1076`, called at `StudentDashboard.tsx:365`.
- Query: `studentId` (child User id). **Optional for a parent**: without it the parent only receives announcements with `targetType:"all"`. With it, it must be a valid ObjectId **and** a child of this parent, else 403. A student account ignores it and uses its own id.
- Returns `status:"approved"` announcements where `targetType:"all"` **or** `targetStudentIds` contains the child, sorted `approvedAt` desc then `createdAt` desc.
- Success 200: `{ "success": true, "announcements": [ Announcement ] }`. `targetStudentIds` is **not populated** here (ids).
- `Announcement` (`backend/models/Announcement.js`):

| Field | Type | Notes |
|---|---|---|
| `_id` | string | |
| `title`, `body` | string | |
| `authorRole` | `"tutor"\|"admin"` | |
| `author` | `{firstName, lastName}` (+`_id` for tutors) | **For `authorRole:"admin"` the server replaces the author with `{ "firstName": "Bee Bright", "lastName": "Admin" }` (no `_id`)** (`announcementController.js:171-175`). Tutor authors keep their real name. |
| `category` | `sick_leave\|exam\|quiz\|materials\|reschedule\|reminder\|suspension\|maintenance\|holiday\|general` | web also knows a legacy `exam_quiz` label |
| `scheduledDate` | ISO \| null | event date |
| `status` | `"pending"\|"approved"\|"rejected"` | always `approved` here |
| `targetType` | `"specific_students"\|"all"` | |
| `targetStudentIds` | string[] | |
| `approvedBy` | id \| null | not populated |
| `approvedAt` | ISO \| null | |
| `rejectedAt`, `rejectionReason` | ISO\|null, string\|null | |
| `createdAt`, `updatedAt` | ISO | |

```json
{
  "success": true,
  "announcements": [
    { "_id": "6ab700000000000000000009", "title": "Center holiday", "body": "Closed on Friday.",
      "authorRole": "admin", "author": { "firstName": "Bee Bright", "lastName": "Admin" },
      "category": "holiday", "scheduledDate": "2026-10-02T00:00:00.000Z", "status": "approved",
      "targetType": "all", "targetStudentIds": [], "approvedBy": "6ab000000000000000000099",
      "approvedAt": "2026-09-24T06:00:00.000Z", "rejectedAt": null, "rejectionReason": null,
      "createdAt": "2026-09-24T05:00:00.000Z", "updatedAt": "2026-09-24T06:00:00.000Z" }
  ]
}
```
- Errors: 403 `{"success":false,"message":"Select one of your own children."}` (non-ObjectId or not-owned `studentId`); 400 `"Invalid student id"` (student account with a malformed id); role errors from `authorize`; 500 `"Failed to load announcements"`.

---

## 13. `GET /api/notifications/badges?childKey=`  (sidebar red-count badges)

- Route `backend/routes/notificationRoutes.js`, mounted `server.js:181`; handler `backend/controllers/notificationController.js:148-186`; web `api.ts:527-531`, `frontend/src/lib/navBadges.ts:51`. The web sends header `X-BB-Passive: 1` (so polling does not extend the session).
- Query: `childKey` — parents only: the child's **permanent Student ID** (an enrollment `_id` is accepted for legacy rows). Must match `^[\w-]{1,64}$`, otherwise it is silently ignored (then counts cover all children). Ignored for other roles.
- Success 200: `{ "success": true, "badges": { … } }`. The keys depend on the caller's role; **every count is a non-negative integer** and keys are always present (never null):
  - **parent / student**: `schedule`, `progress`, `announcements`, `payments`
    - `schedule` = sessions created/changed since this child's Schedule was last opened (attendance-only changes ignored); `progress` = published remarks since last opened; `announcements` = approved announcements (all-families or targeted at the child) since last opened; `payments` = number of enrollments **for that child** that still owe the remaining 50% (down payment verified, balance > 0, no remaining payment awaiting review) — *state*, not "since seen".
  - **tutor**: `students`, `assessments`, `schedule`, `attendance`, `announcements`
  - **admin / super_admin**: `users`, `enrollments`, `payments`, `remarks`, `announcements` (the Requests badge is separate: `/api/escalations/…`, not documented here).
  - Unknown role → `{"success":true,"badges":{}}`.
- Sample (parent): `{"success":true,"badges":{"schedule":3,"progress":1,"announcements":1,"payments":1}}`.
- First call for a section/child writes a "seen = now" baseline so old items don't all count (`notificationController.js:157-171`), so a brand-new account sees zeros.
- Errors: 404 `"User not found"`; 500 `"Failed to load notification badges"`; common 401s.

## 14. `POST /api/notifications/seen`

- Handler `notificationController.js:187-`; web `api.ts:532-533`, `navBadges.ts:81`.
- Body: `section` (string, required) — one of the "new since seen" sections for the role: parent/student `schedule|progress|announcements`; tutor `students|assessments|schedule|announcements`; admin/super_admin `users`. `childKey` (optional string, parents; same pattern as above; an unsafe/invalid key falls back to the section-level key).
- Success 200: `{ "success": true }`.
- Errors: 400 `{"success":false,"message":"This section has no \"new\" badge to clear."}` (e.g. `payments` — action counts can't be cleared); 500 `"Failed to update badge state"`.

---

## 15. `PUT /api/enrollments/child-photo`  (parent sets a child's picture)

- Route `enrollmentRoutes.js:50` (`protect`); handler `enrollmentController.js:464-507`; web `api.ts:302`, called from `frontend/src/components/parent/ParentStudentInfoCard.tsx:38`.
- Body (JSON): `childKey` (string, required — the child's permanent Student ID; an enrollment `_id` also works), `image` (string, required — `data:image/png|jpeg|jpg|webp;base64,…`, **≤ 5 MB**, file signature must match).
- Success 200:
```json
{ "success": true, "message": "Student profile picture updated.", "studentProfileImage": "/uploads/student-avatars/BB-20260901-0001-1789000000002-a1b2c3.png" }
```
  The path is written to **every** enrollment of that child; the old file is deleted. Use the returned path for immediate UI refresh (the web calls `setChildPhoto` in `SelectedChildContext`).
- Errors: 403 `"Only a parent can set a child's profile picture."`; 400 `"childKey is required."`; 400 `"Please provide an image (base64 data URL)."`; 400 `"Please upload a JPG, PNG, or WEBP image."`; 400 `"Image size must be under 5MB."`; 400 `"Image content is not a valid JPG, PNG, or WEBP file."`; 404 `"Child not found on your account."`; 500 `"Failed to update the profile picture."`. Body limit for JSON is 10 MB (`server.js:101`).

---

# Answers A–E

## A. Is the receipt PDF generated client-side or by an endpoint?
**Client-side.** `frontend/src/lib/receiptPdf.ts` — function `downloadPaymentReceipt(data)` (`:20`), using `jsPDF` (`frontend/package.json:55`); it ends with `doc.save("<bbId>.pdf")` (`:85`). **No backend receipt endpoint exists** (NOT FOUND; the only `receipt` hits in `backend/` are chatbot text).
- Input `ReceiptData` (`receiptPdf.ts:3-12`): `bbId` (string → printed as **"Application ID"** and used as the file name), `fullName` (string), `amount` (number, printed as `PHP <rounded, thousands-separated>`), `transactionId` (optional string, printed only if present), `transactionDate` (ISO string or Date, printed `toLocaleDateString("en-PH", long)`). Also prints a fixed "Paid" pill and a footer. Page is 360×480 pt.
- Data sources (`frontend/src/pages/StudentPayments.tsx`):
  - Invoice-level Download (`:483-489`): `bbId = currentInvoice.studentId || currentInvoice.id` (the **permanent Student ID** — `displayStudentId(enrollment)`, `frontend/src/lib/children.ts:56-58`), `fullName = childName` (`studentSnapshot.firstName + lastName`), `amount = amountPaid` (sum of `amountPaid ?? amountDue ?? amount` over `payments` with `status === "verified"`, `StudentPayments.tsx` `computeAmountPaid`), `transactionId = payment.referenceNumber` of the remaining payment when fully paid else the down payment, `transactionDate = payment.verifiedAt` (fallback: now).
  - Payment-history row Download (`:552-558`): same fields for that single verified payment (`amount` = that payment's amount).
- So everything comes from `GET /api/enrollments/my-enrollments` (§2); nothing extra is fetched.

## B. How does the web get the tutor's programs and students for Create Remarks?
**Derived client-side from `GET /api/schedules/my-sessions` (§4). No dedicated endpoint.**
- `TutorDashboard.tsx:280-289` loads `sessions`.
- `tutorRemarkAssignmentPairs` (`TutorDashboard.tsx:582-601`): for every session with a `subject`, the subject **name** is mapped to a program category by text matching (`inferProgramCategoryIdFromSubjectName`, `:173-198`: contains "toddler"/"playgroup" → TPG101; "exam"/"review"/"entrance"/"prep"… → EXP106; "tutorial"/"math"/"english"/"science"/… → ACT102). Then for each populated student in `student` + `students[]` (`sessionStudentRecords`, `:135-`) it records a `(programCode, studentId, name)` pair, de-duplicated. A schedule with no student attached contributes nothing.
- `tutorActiveRemarkPrograms` (`:604-610`): programs that have ≥ 1 pair → these are the "Remark type" buttons (always shown, even if only one; if none: text "You have no active program assignments yet.").
- `studentsForRemarkType` (`:612-620`): pairs for the chosen `programCode`, sorted by name → the Student dropdown; changing the type clears the student.
- The server re-checks the same rule on create (`tutorHandlesStudentForProgram`, §9a), using `Schedule.subject.code`/name via `resolveProgramCode` (`schedulingPolicy.js:88-93`) — so the two use slightly different name→program matching (web: substring keywords; server: `subject.code` first, then name substrings from `SUBJECT_NAME_TO_CODE`, `schedulingPolicy.js:80`). Keep both in mind for Android.
- Card list for "My Students" uses the separate `GET /api/schedules/my-students` (§5). `GET /api/announcements/my-students` (`announcementController.js:313-330`, tutor only) returns a different list used only for announcement targeting: `{ success:true, students:[{ _id, name, email }] }` — one-on-one `student` only (`Schedule.find({tutor}).distinct('student')`), so it **misses playgroup children**.

## C. Exact enum values
| Field | Values | Source |
|---|---|---|
| `attendanceStatus` (Schedule) | `"unmarked"`, `"present"`, `"absent"` (default `"unmarked"`); the PATCH body accepts only `"present"` / `"absent"` | `backend/models/Schedule.js:103-107`; `scheduleController.js:2555` |
| Payment `status` | `"pending"`, `"submitted"`, `"verified"`, `"rejected"` (default `"pending"`) | `backend/models/Payment.js:76-80` |
| Payment `paymentType` | `"full"`, `"down"`, `"remaining"` | `Payment.js:70-74` |
| `paymentMethod` (Payment) | `"gcash"`, `"maribank"`, `"bdo"`, `"blockchain"`, `"cash"` (default `"gcash"`). Parents can submit only `gcash`/`maribank`/`bdo` (`enrollmentController.js:45` `VALID_PAYMENT_METHODS`); `cash` = admin walk-in; `blockchain` legacy | `Payment.js:83-90` |
| Enrollment `paymentStatus` | `"pending"`, `"submitted"`, `"verified"`, `"rejected"`, `"paid"`, `"failed"`, `"partial"`, `"pending_verification"` | `Enrollment.js:167-171` |
| Enrollment `status` | `"draft"`, `"submitted"`, `"payment_under_verification"`, `"pending_approval"`, `"approved"`, `"rejected"`, `"cancelled"`, `"active"` (legacy alias of approved), `"completed"` | `Enrollment.js:151-165` |
| `sessionType` (Schedule) | `"one-on-one"`, `"small-group"`, `"playgroup"` (default `"one-on-one"`) | `Schedule.js:7-11` |
| Remark `status` | `"draft"`, `"pending_admin_review"`, `"published"` (default `"draft"`) | `backend/models/Remark.js:68-72` |
| Remark `programCode` | `"TPG101"`, `"ACT102"`, `"EXP106"` | `Remark.js:23` |
| Remark `templateType` | `"toddler_observation"`, `"academic_progress"`, `"examination_progress"` | `Remark.js:24-28` |
| Announcement `status` / `authorRole` / `targetType` | `pending\|approved\|rejected` / `tutor\|admin` / `specific_students\|all` | `Announcement.js:16-46` |
| User `role` | `student`, `tutor`, `parent`, `admin`, `super_admin` | `frontend/src/contexts/AuthContext.tsx:11` |

How the web derives an **invoice status** from these (not an API field) — `StudentPayments.tsx` `invoiceStatus`: `paid` if `paymentStatus === "paid"` or total > 0 and remaining ≤ 0; else `remaining_review` if the `remaining` payment is `submitted`; else `down_paid` if the down payment is `verified`; else `rejected` if the down payment is `rejected`; else `under_review` if it is `submitted`; else `pending`. Outstanding balance = `max(0, totalFee − Σ verified amountPaid)`; down payment = 50% (`ceil(total*0.5)`); the due date shown is `createdAt + 7 days` computed in the client (no due-date field exists).

## D. Dates and time zones
- **All timestamps/dates in JSON are ISO-8601 UTC strings** with milliseconds and `Z` (Mongoose `Date` → `JSON.stringify`). No epoch numbers.
- **Schedule `date`**: stored as **UTC midnight of the session's calendar day** — creators build it as `new Date('YYYY-MM-DD' + 'T00:00:00.000Z')` (`scheduleController.js:42, 1023, 1159`, or `Date.UTC(...)` `:56, 1694`). So `"2026-09-28T00:00:00.000Z"` means **28 Sept regardless of the viewer's time zone**. Read the **first 10 chars / UTC date parts**, don't convert to local time (web does this: `toStableDateKey` `StudentDashboard.tsx:109-116`, `dateOnly` in `AttendanceTab.tsx`). Server helpers use UTC parts too (`toDateOnly`, `scheduleController.js:49-52`).
- **`startTime` / `endTime`**: plain strings `"HH:MM"`, 24-hour, **no zone, no date** — they are wall-clock times at the center. Operating window 08:00–17:00, Mon–Sat, no session overlapping 12:00–13:00 (`backend/utils/schedulingPolicy.js:1-5, 109-118`). Combine as `date` (calendar day) + `startTime` (local center time).
- **No time-zone configuration exists** on the server or web: NOT FOUND for `Asia/Manila`, `timeZone`, or `process.env.TZ` in `backend/` and `frontend/src`. The web compares session end times to the **device's local clock** (`nowMinutes` in `StudentDashboard.tsx:705-722`), i.e. it implicitly assumes the device is in the center's zone.
- **Server "today" is UTC**, not Manila: `markAttendance` compares the session's UTC day to `toDateOnly(now)` (UTC) (`scheduleController.js:2569-2579`), and "attendance unmarked" badges use `new Date()` bounds. Between 00:00 and 08:00 Manila time (16:00–24:00 UTC the previous day) the server still considers the previous UTC day "today". Worth knowing if the Android app enforces its own "can mark today" rule.
- Other dates: `studentSnapshot.birthdate` is an ISO datetime at UTC midnight (web uses `.slice(0,10)`); remark `date` is stored as sent (`new Date('YYYY-MM-DD')` → UTC midnight) and displayed with `toLocaleDateString`.

## E. Image URLs: full URL, relative path, or data URL? Auth needed?
| Image | What the API returns | Loading needs auth? | Source |
|---|---|---|---|
| **`studentProfileImage`** (child photo) | **Relative path with leading slash**: `/uploads/student-avatars/<file>` (or `null`) | **No** — public static | `enrollmentController.js:489-491`, static mount `server.js:124-128` |
| Enrollment 2×2 photo / birth cert / guardian ID (`requirementDocuments.*.path`) | Relative path `/uploads/requirements/<file>` | **No** (public static) | `enrollmentController.js:74-84` |
| **Payment proof** (`payments[].proofUrl`) | Relative path `/uploads/payments/proof-…` (or `null`) | **No** (public static) | `enrollmentController.js:58-68` |
| User avatar in `user.profileImageUrl` (login, `/auth/me`) | **Full URL** `http(s)://<host>/uploads/avatars/<file>` (built from the request host) or `null` | No | `authController.js:76-80` |
| User avatar inside populated `student`/`tutor(s)` objects (`profileImage`) | **Bare storage path** `avatars/<file>` (no leading slash, no `/uploads`) | No — build `<base>/uploads/<profileImage>` | web: `AdminDashboard.tsx` / `TutorDashboard.tsx` use `` `${uploadsBaseUrl}/uploads/${profileImage}` `` |
| **Remark attachment** | Never a URL. JSON only has `attachment.path` (a private disk filename) | **Yes** — fetch `GET /api/remarks/:id/attachment` with the token, treat response as a blob | §11 |
- To render a relative path, prefix the API host **without** `/api`: web does `uploadsBaseUrl = VITE_API_URL.replace(/\/api\/?$/, '')` (`api.ts:869`) and `resolveUploadUrl` (`frontend/src/lib/children.ts:60-65`: keeps `http(s):`, `data:`, `blob:` as-is, otherwise `base + '/' + path-without-leading-slashes`).
- **Data URLs go only from client to server** (uploads): `image` for child photo, `proofDataUrl` for payment proof, `attachmentDataUrl` for remarks, `requirementDocuments.*.dataUrl` in enrollment submit. The API never returns a data URL.
- **Caveat:** anything under `/uploads` is served by `express.static` with **no authentication** (`server.js:124-128`); anyone with the URL can fetch it. Android can load these with a plain image loader; do not assume they are private.

---

# Flags and inconsistencies found while scanning
1. **Playgroup capacity: the web hard-codes 10, the server allows 12.** Web text `"{n} / 10 enrolled"` at `frontend/src/pages/TutorDashboard.tsx:1827`; server `PLAYGROUP_MAX_CHILDREN = 12` (`backend/utils/schedulingPolicy.js:17`) and `maxCapacity: 12` (`sessionTypeManager.js:24`). Use each schedule's `maxCapacity`. (This corrects my earlier chat summary, which said 10.)
2. `PUT /api/remarks/:id` returns a legacy message mentioning "Correct Published Remark" for non-drafts (`remarkController.js:275`) — that feature was removed.
3. `GET /api/remarks/my-progress` does not validate that `studentId` is a valid ObjectId before the ownership query (unlike `/announcements/student`); a malformed id likely produces a 500 with a Mongoose cast message. Inferred, not exercised.
4. `activity` filter on `my-progress` is used as a raw regex (`$regex: String(activity)`).
5. `GET /api/auth/me` can omit `phone`, `gradeLevel`, `guardianName`, etc. when unset; login responses never include `phone` or a combined `name`.
6. Legacy `permanentStudentId: null` rows exist until the startup backfill runs; always fall back to `_id` for grouping.
7. There is no "session number" and no per-child attendance for playgroup sessions in the data model.
8. `GET /api/announcements/my-students` (tutor) omits playgroup children; use `/api/schedules/my-students` for a complete roster.
9. `X-BB-Passive: 1` is only sent by the badge poll; other periodic calls refresh the server-side inactivity timer.
