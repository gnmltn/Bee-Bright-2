# Bee Bright Threat Model

## 1. Scope
This threat model covers the Bee Bright tutorial center platform across:
- `frontend/` web client
- `backend/` Node.js + Express API
- `MongoDB` data store
- `contracts/BeeBrightPayments.sol`
- AI chatbot and recommendation features

## 2. Security Objectives
- Protect student, tutor, admin, and super admin accounts from unauthorized access.
- Protect enrollment, payment, grade, schedule, and announcement records from tampering.
- Ensure blockchain payments remain traceable and linked to an enrollment reference.
- Prevent abuse of public-facing AI and chatbot endpoints.
- Preserve audit evidence for critical administrative and authentication actions.

## 3. Data Flow Diagram
See [DFD.mmd](/c:/BRIGHTBEE/beebright-ui-showcase/docs/DFD.mmd) for the system data flow diagram in Mermaid format.

## 4. Trust Boundaries
- Public internet user -> Bee Bright frontend
- Frontend -> backend API
- Backend API -> MongoDB
- Backend API -> SMTP provider
- Frontend wallet / MetaMask -> smart contract
- Backend / frontend -> AI runtime and generated rules

## 5. STRIDE Analysis
| Component | Spoofing | Tampering | Repudiation | Information Disclosure | Denial of Service | Elevation of Privilege | Existing / Added Mitigations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Authentication API | Stolen token, brute-force login | Captcha bypass attempts | Failed-login denial | Password/token leakage | Login flooding | Role escalation | JWT validation, bcrypt, captcha challenge, rate limiting, audit logs, public signup limited to students |
| Admin / Super Admin management | Impersonation of privileged user | User archive/delete misuse | Admin denies action | Overbroad user listing | API abuse | Admin managing super admin data | RBAC, narrowed account-management scope, audit trail |
| Enrollment and payment forms | Fake submissions | Payment proof or enrollment edits | Disputed actions | Sensitive record exposure | Form spam | Unauthorized status changes | Validation, NoSQL sanitization, audit trail, payment verification flow |
| File uploads | Malicious file masquerading | Avatar / material replacement | Uploader denies action | XSS via active content | Oversized file upload | Upload leading to code execution | MIME/extension validation, avatar signature check, `nosniff`, size limits |
| MongoDB datastore | Stolen DB credentials | Record tampering | Deletion without trace | PII leakage | Query exhaustion | Privilege misuse | Authenticated queries, role checks, audit logs, backup procedure, TLS requirement in production docs |
| Smart contract | Fake payment source | Enrollment ref omission | Payer denies payment | Public event leakage | Gas griefing | Unauthorized admin controls | Immutable wallet, enrollment reference required, direct transfers reverted, automated tests |
| AI chatbot | Prompt spoofing | Reply manipulation | User denies abusive use | Sensitive context leakage | Prompt flooding | Public endpoint abuse | Scoped system prompt, grounded responses, rate limits, behavior benchmarks |

## 6. OWASP-Focused Risk Register
| ID | Risk | OWASP Category | Likelihood | Impact | Score | Mitigation Status |
| --- | --- | --- | --- | --- | --- | --- |
| TM-01 | Public signup to privileged role | A01 Broken Access Control | High | Critical | 5x5 = 25 | Fixed in backend registration path |
| TM-02 | Admin API manages admin accounts | A01 Broken Access Control | Medium | High | 4x4 = 16 | Fixed via role-scoped management rules |
| TM-03 | Avatar upload with active content | A03 Injection / A05 Security Misconfiguration | Medium | High | 4x4 = 16 | Fixed by rejecting SVG and validating signatures |
| TM-04 | Open-origin API access | A05 Security Misconfiguration | Medium | Medium | 4x3 = 12 | Fixed with explicit CORS allowlist |
| TM-05 | Chatbot flooding / spam | A04 Insecure Design / A10 SSRF-like abuse patterns | Medium | Medium | 3x3 = 9 | Reduced with endpoint rate limits |
| TM-06 | Weak reset passwords | A07 Identification and Authentication Failures | Medium | Medium | 3x3 = 9 | Fixed by enforcing strong password rules |
| TM-07 | Dependency vulnerability in throttling library | A06 Vulnerable and Outdated Components | Medium | High | 3x4 = 12 | Fixed with `npm audit fix` and manifest update |

## 7. Risk Scoring Method
- Likelihood: `1` rare -> `5` very likely
- Impact: `1` low -> `5` critical
- Score: `Likelihood x Impact`
- Priority bands:
  - `20-25`: Critical
  - `12-19`: High
  - `6-11`: Medium
  - `1-5`: Low

## 8. Mitigation Summary
- Hardened authentication, registration, and reset-password validation
- Restricted CORS to known frontend origins
- Role-scoped account management for admin vs super admin
- File upload hardening and static file `nosniff`
- AI endpoint rate limiting
- Audit logging for authentication and administrative actions
- Smart contract custom errors, revert-only fallback, and test coverage

## 9. Residual Risks
- JWT revocation is still client-side only; there is no server-side token blacklist.
- CSRF tokens are not used because auth relies on bearer tokens in session storage instead of cookies.
- Database backup enforcement depends on deployment operations; the repository now includes a backup script and procedure, but runtime scheduling still needs ops setup.

## 10. Defense Talking Point
Bee Bright’s threat model is not just a document. Each high-risk item was mapped to a concrete mitigation in code, then validated through route restrictions, rate limiting, stronger input handling, audit logging, and contract tests.
