const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']); 

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const {
  loadEnvironment,
  validateEnv,
  getMongoConnectionOptions,
  getDatabaseSecurityStatus,
} = require('./config/env');
const { verifyEmailTransport, getEmailErrorMessage } = require('./utils/emailService');

// Load env vars first (never commit .env; use .env.example as template)
loadEnvironment();
validateEnv();

mongoose.set('strictQuery', true);

verifyEmailTransport()
  .then((result) => {
    console.log(`✅ Email transport ready (${result.service}) for ${result.user}`);
  })
  .catch((error) => {
    console.warn(`⚠️ Email transport unavailable: ${getEmailErrorMessage(error)}`);
  });

// Import routes
const authRoutes = require('./routes/authRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const enrollmentRoutes = require('./routes/enrollmentRoutes');
const userRoutes = require('./routes/userRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const subjectRoutes = require('./routes/subjectRoutes');
const scheduleRoutes = require('./routes/scheduleRoutes');
const weeklyScheduleRoutes = require('./routes/weeklyScheduleRoutes');
const sessionEnrollmentRoutes = require('./routes/sessionEnrollmentRoutes');
const aiRoutes = require('./routes/aiRoutes');
const learningMaterialRoutes = require('./routes/learningMaterialRoutes');
const gradeRoutes = require('./routes/gradeRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const auditRoutes = require('./routes/auditRoutes');
const escalationRoutes = require('./routes/escalationRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const adminCreationRoutes = require('./routes/adminCreationRoutes');
const assessmentRoutes = require('./routes/assessmentRoutes');
const { ensureSuperAdmin } = require('./utils/ensureSuperAdmin');
const { migrateScheduleIndexes } = require('./utils/scheduleIndexMigration');
const { ensureRetiredPricing } = require('./utils/retireLegacyPricing');
const { ensureAssessmentTemplates } = require('./utils/ensureAssessmentTemplates');
const { getAuthTokenFromCookies } = require('./utils/authCookie');
const { warmUpOllama } = require('./utils/ollamaWarmup');

const app = express();
app.set('trust proxy', 1);

// Security headers (Helmet)
app.use(helmet({
  contentSecurityPolicy: false, // Disable if you use inline scripts; enable and tune for production
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CRITICAL FIX: Proper CORS configuration
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    // List of allowed origins
    const allowedOrigins = new Set([
      'http://localhost:3000',
      'http://localhost:8080',
      'http://localhost:5173', // Vite default
      'http://localhost:5174',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:8080',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5174',
      process.env.CLIENT_URL,
      process.env.FRONTEND_URL
    ].filter(Boolean)); // Remove undefined values

    if (allowedOrigins.has(origin)) {
      callback(null, true);
    } else {
      console.warn('⚠️ CORS blocked origin:', origin);
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// NoSQL injection guard - sanitize body/query (must run after body parsing)
const { noSqlInjectionGuard } = require('./middleware/sanitize');
app.use(noSqlInjectionGuard);

// Request logging - never log Authorization or password fields
app.use((req, res, next) => {
  const safeBody = req.method !== 'GET' && req.body ? { ...req.body } : undefined;
  if (safeBody) {
    if (safeBody.password) safeBody.password = '[REDACTED]';
    if (safeBody.currentPassword) safeBody.currentPassword = '[REDACTED]';
    if (safeBody.newPassword) safeBody.newPassword = '[REDACTED]';
    if (safeBody.token) safeBody.token = '[REDACTED]';
  }
  const hasAuth = !!req.headers.authorization || !!getAuthTokenFromCookies(req);
  console.log(`${req.method} ${req.path}`, { body: safeBody, query: req.query, auth: hasAuth ? 'present' : 'none' });
  next();
});

// Serve uploaded files (e.g. profile images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// Connect to MongoDB
const mongoConnectionOptions = getMongoConnectionOptions();
const dbSecurityStatus = getDatabaseSecurityStatus();

console.log('🛡️ Database security status', {
  localDatabase: dbSecurityStatus.localDatabase,
  authenticatedMongoUri: dbSecurityStatus.authenticatedMongoUri,
  tlsEnforced: dbSecurityStatus.tlsEnforced,
  tlsCaFileConfigured: dbSecurityStatus.tlsCaFileConfigured,
  backupRootConfigured: dbSecurityStatus.backupRootConfigured,
  backupRetentionDays: dbSecurityStatus.backupRetentionDays,
  fieldEncryptionConfigured: dbSecurityStatus.fieldEncryptionConfigured,
});

mongoose.connect(process.env.MONGODB_URI, mongoConnectionOptions)
.then(async () => {
  console.log('✅ MongoDB Connected');
  try {
    await migrateScheduleIndexes();
    await ensureSuperAdmin();
    await ensureRetiredPricing();
    await ensureAssessmentTemplates();
  } catch (err) {
    console.error('❌ Startup initialization task failed:', err);
  }
})
.catch(err => console.error('❌ MongoDB Connection Error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/enrollments', enrollmentRoutes);
// Admin enrollment management (mirrors /api/enrollments but under /api/admin/enrollments)
app.use('/api/admin/enrollments', enrollmentRoutes);
app.use('/api/users', userRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/admin/weekly-schedules', weeklyScheduleRoutes);
app.use('/api/sessions', sessionEnrollmentRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/materials', learningMaterialRoutes);
app.use('/api/grades', gradeRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/escalations', escalationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin-invites', adminCreationRoutes);
app.use('/api/assessments', assessmentRoutes);

// New value on every process start. The enrollment wizard stores it alongside
// its client-side draft and wipes the draft when it changes — so stopping and
// restarting the server (or the machine) drops any in-progress enrollment,
// while a plain page refresh keeps it. Nothing is persisted server-side.
const SERVER_INSTANCE_ID = crypto.randomUUID();

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Bee Bright API is running',
    instanceId: SERVER_INSTANCE_ID,
    timestamp: new Date(),
    environment: process.env.NODE_ENV
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 API URL: http://localhost:${PORT}/api`);
  console.log('='.repeat(50));
  // Task 29b — pre-warm phi so the first user needing it doesn't pay the cold-start cost.
  // Fire-and-forget; never blocks startup or throws.
  warmUpOllama();
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`⚠️ Port ${PORT} is already in use. Another backend instance may already be running.`);
    process.exit(0);
  }

  console.error('❌ Server failed to start:', error);
  process.exit(1);
});

module.exports = app;
