const path = require('path');
const multer = require('multer');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'material');

// Max filename length (bytes) to avoid filesystem issues
const MAX_FILENAME_LENGTH = 200;
// Max file size: 80MB for videos
const MAX_FILE_SIZE = 80 * 1024 * 1024;

// Ensure directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Extension whitelist (must match one of these to accept)
const ALLOWED_EXTENSIONS = [
  '.pdf', '.mp4', '.webm', '.mov', '.avi',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
  '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv',
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const raw = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const base = `${Date.now()}-${raw}`;
    const safeName = base.length > MAX_FILENAME_LENGTH
      ? base.slice(0, MAX_FILENAME_LENGTH - path.extname(base).length) + path.extname(base)
      : base;
    cb(null, safeName);
  },
});

// MIME types that are allowed (server-side check)
const allowedMimes = [
  'application/pdf',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
];

function getExtension(name) {
  const ext = path.extname((name || '').toLowerCase());
  return ext || '';
}

const fileFilter = (req, file, cb) => {
  const ext = getExtension(file.originalname);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return cb(new Error(`File extension not allowed: ${ext || '(none)'}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`), false);
  }
  if (!allowedMimes.includes(file.mimetype)) {
    return cb(new Error(`File type not allowed: ${file.mimetype}. Allowed: PDF, video, images, Word, Excel, text.`), false);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

module.exports = { upload, UPLOAD_DIR };
