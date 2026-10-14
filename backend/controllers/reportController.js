const PDFDocument = require('pdfkit');
const Enrollment = require('../models/Enrollment');
const Payment = require('../models/Payment');
const User = require('../models/User');
const WeeklyDigest = require('../models/WeeklyDigest');
// Namespace import (not destructured) so backend/test/weeklyDigest.test.js can stub
// geminiClient.generateDigestNarrative in place — a destructured reference would keep
// pointing at the original function after the test reassigns the module's export.
const geminiClient = require('../utils/geminiClient');
const { logAudit } = require('../utils/auditService');
const { emitToAdmins } = require('../utils/realtime');

const getSettledValue = (result, fallback) =>
  (result.status === 'fulfilled' ? result.value : fallback);

function normalizeDayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function normalizeDayEnd(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

// The admin's Reports-tab week picker (frontend) builds real Monday-Sunday calendar
// weeks, clipped to partial weeks at a month's start/end, and sends the exact boundary
// pair it computed — there is no "current week" default any more, since Generate Report
// always requires an explicit pick. This just validates/normalizes what was sent and
// rejects a period that hasn't happened yet (there's nothing to report on).
function resolveRequestedWeek(body) {
  const { weekStart: rawStart, weekEnd: rawEnd } = body || {};
  if (!rawStart || !rawEnd) return { error: 'weekStart and weekEnd are required.' };
  const weekStart = normalizeDayStart(rawStart);
  const weekEnd = normalizeDayEnd(rawEnd);
  if (Number.isNaN(weekStart.getTime()) || Number.isNaN(weekEnd.getTime())) {
    return { error: 'weekStart and weekEnd must be valid dates.' };
  }
  if (weekStart > weekEnd) return { error: 'weekStart must be on or before weekEnd.' };
  // weekStart is already start-of-day and weekEnd end-of-day, so their raw difference
  // already rounds to the inclusive day count (e.g. Mon 00:00:00.000 to Sun 23:59:59.999
  // is 6.99998 days -> 7) — adding +1 on top would double-count.
  const spanDays = Math.round((weekEnd.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
  if (spanDays > 7) return { error: 'A digest can cover at most 7 days.' };
  if (weekEnd > normalizeDayEnd(new Date())) {
    return { error: 'Cannot generate a digest for a period that has not happened yet.' };
  }
  return { weekStart, weekEnd };
}

// "In-flight" = not yet resolved either way. Mirrors the real Enrollment.status enum
// (backend/models/Enrollment.js) — draft/approved/active/completed/rejected/cancelled are
// all deliberately excluded (either not yet real, or already resolved).
const IN_FLIGHT_ENROLLMENT_STATUSES = ['submitted', 'payment_under_verification', 'pending_approval'];
const NEEDS_FOLLOWUP_PAYMENT_STATUSES = ['pending', 'submitted', 'rejected'];
const MAX_FOLLOWUPS = 10;

// All counts/totals here are computed in plain aggregation queries — this is the data
// Gemini is given to narrate; it never sees raw DB records or decides what to compute.
async function aggregateWeeklyStats(weekStart, weekEnd) {
  const dateRangeMatch = { createdAt: { $gte: weekStart, $lte: weekEnd } };

  const [
    enrollmentStatusResult,
    paymentStatusResult,
    activeUsersResult,
    roleBreakdownResult,
    topProgramResult
  ] = await Promise.allSettled([
    Enrollment.aggregate([
      { $match: dateRangeMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    // Same date-fallback pattern as dashboardController.js's getMonthlyRevenue: a
    // payment's effective date is when it was verified, falling back to when it was
    // created for payments still pending/submitted/rejected.
    Payment.aggregate([
      { $addFields: { dateToUse: { $ifNull: ['$verifiedAt', '$createdAt'] } } },
      { $match: { dateToUse: { $gte: weekStart, $lte: weekEnd } } },
      { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$amount' } } }
    ]),
    // Active users reflects the CURRENT roster (not scoped to the week), same as the
    // existing dashboard stat card.
    User.countDocuments({ isActive: true, isArchived: { $ne: true }, deletedAt: null }),
    User.aggregate([
      { $match: { isActive: true, isArchived: { $ne: true }, deletedAt: null } },
      { $group: { _id: '$role', count: { $sum: 1 } } }
    ]),
    // packages[].programCode/displayName is the authoritative program field (not the
    // legacy selectedSubjects the frontend's existing Top Subjects card still reads).
    Enrollment.aggregate([
      { $match: dateRangeMatch },
      { $unwind: '$packages' },
      { $group: { _id: { programCode: '$packages.programCode', displayName: '$packages.displayName' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 }
    ])
  ]);

  const enrollmentBreakdown = getSettledValue(enrollmentStatusResult, []).reduce((acc, row) => {
    acc[row._id] = row.count;
    return acc;
  }, {});
  const enrollmentTotal = Object.values(enrollmentBreakdown).reduce((sum, n) => sum + n, 0);

  const paymentBreakdown = {};
  let verifiedTotal = 0;
  let pendingTotal = 0;
  for (const row of getSettledValue(paymentStatusResult, [])) {
    paymentBreakdown[row._id] = { count: row.count, total: row.total || 0 };
    if (row._id === 'verified') verifiedTotal += row.total || 0;
    else pendingTotal += row.total || 0;
  }

  const roleBreakdown = getSettledValue(roleBreakdownResult, []).reduce((acc, row) => {
    acc[row._id] = row.count;
    return acc;
  }, {});

  const topProgramRows = getSettledValue(topProgramResult, []);
  const topProgram = topProgramRows.length
    ? {
      programCode: topProgramRows[0]._id.programCode,
      displayName: topProgramRows[0]._id.displayName,
      count: topProgramRows[0].count
    }
    : null;

  return {
    weekStart,
    weekEnd,
    enrollments: { total: enrollmentTotal, byStatus: enrollmentBreakdown },
    payments: { byStatus: paymentBreakdown, verifiedTotal, pendingTotal },
    activeUsers: { total: getSettledValue(activeUsersResult, 0), byRole: roleBreakdown },
    topProgram
  };
}

// Deliberately minimal identifiers (first name + last initial) — never a full payment
// reference number, email, or phone number, since this list is handed to Gemini and also
// saved/displayed as-is.
function minimizedName(firstName, lastName) {
  const first = String(firstName || '').trim();
  const lastInitial = String(lastName || '').trim().charAt(0).toUpperCase();
  const name = [first, lastInitial ? `${lastInitial}.` : null].filter(Boolean).join(' ');
  return name || 'A student';
}

async function resolveFollowUps(weekStart, weekEnd) {
  const [inFlightEnrollments, flaggedPayments] = await Promise.all([
    Enrollment.find({
      createdAt: { $gte: weekStart, $lte: weekEnd },
      status: { $in: IN_FLIGHT_ENROLLMENT_STATUSES }
    })
      .select('studentSnapshot.firstName studentSnapshot.lastName status createdAt')
      .sort({ createdAt: 1 })
      .limit(MAX_FOLLOWUPS)
      .lean(),
    Payment.find({
      createdAt: { $gte: weekStart, $lte: weekEnd },
      status: { $in: NEEDS_FOLLOWUP_PAYMENT_STATUSES }
    })
      .select('status createdAt amount parent')
      .populate('parent', 'firstName lastName')
      .sort({ createdAt: 1 })
      .limit(MAX_FOLLOWUPS)
      .lean()
  ]);

  const enrollmentFollowUps = inFlightEnrollments.map((e) => ({
    type: 'enrollment',
    label: `${minimizedName(e.studentSnapshot?.firstName, e.studentSnapshot?.lastName)} — enrollment ${String(e.status).replace(/_/g, ' ')}`,
    date: e.createdAt
  }));

  const paymentFollowUps = flaggedPayments.map((p) => ({
    type: 'payment',
    label: `${minimizedName(p.parent?.firstName, p.parent?.lastName)} — payment ${p.status}`,
    date: p.createdAt
  }));

  return [...enrollmentFollowUps, ...paymentFollowUps]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, MAX_FOLLOWUPS);
}

function formatDateLabel(date) {
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Shared by both the generate and re-download routes, so a past digest's PDF is always
// byte-for-byte reproducible from its saved reportText/followUps — no Gemini call here.
function renderDigestPdf({ weekStart, weekEnd, reportText, followUps = [] }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#000').text('BeeBright Weekly Digest');
    doc.fontSize(11).font('Helvetica').fillColor('#666')
      .text(`${formatDateLabel(weekStart)} - ${formatDateLabel(weekEnd)}`);
    doc.moveDown(1.5);

    // The narrative always ends with its own "Needs Follow-up:" section (guaranteed by
    // geminiClient.js's system prompt, built from this exact same followUps list) — split
    // it out so it renders as a visually distinct, highlighted block instead of blending
    // into the overview paragraph.
    const marker = 'Needs Follow-up:';
    const markerIndex = reportText.indexOf(marker);
    const overview = markerIndex >= 0 ? reportText.slice(0, markerIndex).trim() : reportText.trim();
    const followUpText = markerIndex >= 0 ? reportText.slice(markerIndex + marker.length).trim() : '';

    doc.fillColor('#000').fontSize(12).font('Helvetica').text(overview, { align: 'left', lineGap: 4 });
    doc.moveDown(1);

    doc.fontSize(13).font('Helvetica-Bold').fillColor('#92400e').text('Needs Follow-up');
    doc.moveDown(0.3);
    doc.fontSize(11).font('Helvetica').fillColor('#78350f');
    if (followUpText) {
      doc.text(followUpText, { align: 'left', lineGap: 3 });
    } else if (!followUps.length) {
      doc.text('Nothing needs follow-up this week.');
    }

    doc.end();
  });
}

// @desc    Generate an AI digest for an admin-chosen week, save it, and return the PDF.
//          Reuses an existing digest for the exact same week instead of calling Gemini
//          again (its free-tier quota is limited) — the frontend already checks its own
//          Past Digests list before ever calling this; the check here is the server-side
//          safety net for a race (two admins at once) or a stale client-side list.
// @route   POST /api/reports/weekly-digest
// @access  Private (Admin)
// Body: { weekStart, weekEnd } — ISO date strings for the exact week to report on.
const generateWeeklyDigest = async (req, res) => {
  try {
    const { weekStart, weekEnd, error } = resolveRequestedWeek(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const existing = await WeeklyDigest.findOne({ weekStart, weekEnd }).lean();
    if (existing) {
      const pdfBuffer = await renderDigestPdf(existing);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('X-Digest-Cached', 'true');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="beebright_weekly_digest_${weekStart.toISOString().slice(0, 10)}.pdf"`
      );
      return res.status(200).send(pdfBuffer);
    }

    const stats = await aggregateWeeklyStats(weekStart, weekEnd);
    const followUps = await resolveFollowUps(weekStart, weekEnd);

    let reportText;
    try {
      reportText = await geminiClient.generateDigestNarrative(stats, followUps);
    } catch (genError) {
      return res.status(502).json({
        success: false,
        message: genError.message || 'Failed to generate the digest narrative'
      });
    }

    const digest = await WeeklyDigest.create({
      generatedBy: req.user.id,
      weekStart,
      weekEnd,
      reportText,
      followUps,
      stats
    });

    await logAudit({
      req,
      action: 'Generate Weekly Digest',
      module: 'Administrative',
      description: `Generated weekly digest for ${weekStart.toDateString()} - ${weekEnd.toDateString()}`,
      userId: req.user.id,
      metadata: { digestId: digest._id }
    });

    // Another admin who might have this same week-picker open right now should see the
    // new digest (and its "Already generated" state) without a manual refresh.
    emitToAdmins('digest:new', { digestId: String(digest._id), weekStart, weekEnd });

    const pdfBuffer = await renderDigestPdf({ weekStart, weekEnd, reportText, followUps });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="beebright_weekly_digest_${weekStart.toISOString().slice(0, 10)}.pdf"`
    );
    res.status(200).send(pdfBuffer);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to generate weekly digest' });
  }
};

// @desc    List past digests, most recently GENERATED first (not by which week they
//          cover — an admin can generate a digest for an old week at any time, and that
//          should still surface at the top as the newest thing in the list).
// @route   GET /api/reports/weekly-digest
// @access  Private (Admin)
const listWeeklyDigests = async (req, res) => {
  try {
    const digests = await WeeklyDigest.find({})
      .sort({ createdAt: -1 })
      .select('weekStart weekEnd reportText followUps createdAt')
      .lean();
    res.status(200).json({ success: true, digests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to load past digests' });
  }
};

// @desc    Re-render a saved digest's PDF (no Gemini call)
// @route   GET /api/reports/weekly-digest/:id/pdf
// @access  Private (Admin)
const downloadWeeklyDigestPdf = async (req, res) => {
  try {
    const digest = await WeeklyDigest.findById(req.params.id).lean();
    if (!digest) {
      return res.status(404).json({ success: false, message: 'Digest not found' });
    }
    const pdfBuffer = await renderDigestPdf(digest);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="beebright_weekly_digest_${new Date(digest.weekStart).toISOString().slice(0, 10)}.pdf"`
    );
    res.status(200).send(pdfBuffer);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message || 'Failed to download digest PDF' });
  }
};

module.exports = {
  generateWeeklyDigest,
  listWeeklyDigests,
  downloadWeeklyDigestPdf,
  // Exported for backend/test/weeklyDigest.test.js
  resolveRequestedWeek,
  aggregateWeeklyStats,
  resolveFollowUps,
  renderDigestPdf
};
