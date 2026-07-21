/**
 * Student Enrollment Controller (Session-Based)
 * 
 * Handles student enrollment into pre-created template-based sessions
 * (NO admin assignment - students independently enroll)
 */

const Schedule = require('../models/Schedule');
const Enrollment = require('../models/Enrollment');
const User = require('../models/User');
const TutoringArea = require('../models/TutoringArea');
const { logAudit } = require('../utils/auditService');
const {
  isStudentEnrolledInSession,
  hasStudentTimeConflict,
  getSessionCapacityInfo,
  normalizeTime
} = require('../utils/weeklySchedulingUtils');

/**
 * Get available sessions for student to enroll in
 * @route GET /api/sessions/available
 * @access Private (Student)
 * Query params: { dayOfWeek, startDate, endDate, sessionType, subjectId }
 */
const getAvailableSessionsForStudents = async (req, res) => {
  try {
    const { dayOfWeek, startDate, endDate, sessionType, subjectId } = req.query;

    const query = {
      isEnrollableByStudents: true,
      substitutionStatus: { $ne: 'substitute_required' }
    };

    // Filter by day of week if provided
    if (dayOfWeek != null) {
      query.dayOfWeek = Number(dayOfWeek);
    }

    // Filter by date range
    if (startDate || endDate) {
      query.date = {};
      if (startDate) {
        const start = new Date(startDate + 'T00:00:00.000Z');
        if (!isNaN(start.getTime())) {
          query.date.$gte = start;
        }
      }
      if (endDate) {
        const end = new Date(endDate + 'T23:59:59.999Z');
        if (!isNaN(end.getTime())) {
          query.date.$lte = end;
        }
      }
    }

    // Filter by session type
    if (sessionType) {
      query.sessionType = sessionType;
    }

    // Filter by subject
    if (subjectId) {
      query.subject = subjectId;
    }

    const sessions = await Schedule.find(query)
      .populate('tutor', 'firstName lastName email')
      .populate('subject', 'name code')
      .populate('tutoringAreaId', 'name areaType')
      .select('date startTime endTime sessionType tutor subject tutoringAreaId maxCapacity students')
      .sort({ date: 1, startTime: 1 })
      .lean();

    // Add capacity info to each session
    const sessionsWithCapacity = [];
    for (const session of sessions) {
      const currentEnrollment = session.students ? session.students.length : 0;
      const availableSlots = Math.max(0, session.maxCapacity - currentEnrollment);

      sessionsWithCapacity.push({
        ...session,
        currentEnrollment,
        availableSlots,
        isFull: availableSlots <= 0,
        dayName: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][session.dayOfWeek]
      });
    }

    res.status(200).json({
      success: true,
      sessions: sessionsWithCapacity,
      count: sessions.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to retrieve available sessions'
    });
  }
};

/**
 * Enroll student in a session
 * @route POST /api/sessions/:id/enroll
 * @access Private (Student)
 */
const enrollStudentInSession = async (req, res) => {
  try {
    const { id: scheduleId } = req.params;
    const studentId = req.user.id;

    // Get session
    const schedule = await Schedule.findById(scheduleId)
      .populate('subject', '_id code name')
      .populate('tutor', 'firstName lastName')
      .populate('tutoringAreaId', 'name');

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    // Check if session is enrollable
    if (!schedule.isEnrollableByStudents) {
      return res.status(400).json({
        success: false,
        message: 'This session is not available for student enrollment'
      });
    }

    // Check if already enrolled
    const alreadyEnrolled = await isStudentEnrolledInSession(scheduleId, studentId);
    if (alreadyEnrolled) {
      return res.status(400).json({
        success: false,
        message: 'You are already enrolled in this session'
      });
    }

    // Check capacity
    const capacityInfo = await getSessionCapacityInfo(scheduleId);
    if (capacityInfo.isFull) {
      return res.status(400).json({
        success: false,
        message: 'Session is full'
      });
    }

    // Validate student has active enrollment in subject
    const enrollment = await Enrollment.findOne({
      student: studentId,
      status: 'active'
    }).populate('selectedSubjects').lean();

    if (!enrollment) {
      return res.status(400).json({
        success: false,
        message: 'Student has no active enrollment'
      });
    }

    const hasSubject = (enrollment.selectedSubjects || []).some(
      s => (s._id || s).toString() === schedule.subject._id.toString()
    );

    if (!hasSubject) {
      return res.status(400).json({
        success: false,
        message: 'You are not enrolled in the subject for this session'
      });
    }

    // Check for student schedule conflicts
    const conflict = await hasStudentTimeConflict(
      studentId,
      schedule.date,
      schedule.startTime,
      schedule.endTime
    );

    if (conflict) {
      return res.status(400).json({
        success: false,
        message: 'Schedule conflict detected. You already have another session at this time'
      });
    }

    // Enroll student
    if (schedule.sessionType === 'one-on-one') {
      // For one-on-one, can only have one student
      if (schedule.student) {
        return res.status(400).json({
          success: false,
          message: 'Session is full (one-on-one has max capacity of 1)'
        });
      }
      schedule.student = studentId;
    } else {
      // For group sessions, add to students array
      if (!Array.isArray(schedule.students)) {
        schedule.students = [];
      }
      schedule.students.push(studentId);
    }

    await schedule.save();

    // Log audit
    logAudit({
      req,
      userId: studentId,
      action: 'Enroll in Session',
      module: 'Academic',
      description: `Student enrolled in ${schedule.sessionType} session`,
      status: 'SUCCESS',
      metadata: {
        scheduleId,
        sessionType: schedule.sessionType,
        tutor: schedule.tutor._id,
        subject: schedule.subject._id
      }
    }).catch(() => {});

    const updated = await Schedule.findById(scheduleId)
      .populate('student', 'firstName lastName')
      .populate('students', 'firstName lastName')
      .populate('tutor', 'firstName lastName email')
      .populate('subject', 'name code')
      .populate('tutoringAreaId', 'name areaType');

    const currentEnrollment = schedule.sessionType === 'one-on-one'
      ? 1
      : (Array.isArray(updated.students) ? updated.students.length : 0);

    res.status(200).json({
      success: true,
      message: 'Successfully enrolled in session',
      session: updated,
      enrollmentInfo: {
        currentEnrollment,
        maxCapacity: updated.maxCapacity,
        availableSlots: Math.max(0, updated.maxCapacity - currentEnrollment)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to enroll in session'
    });
  }
};

/**
 * Unenroll student from a session
 * @route POST /api/sessions/:id/unenroll
 * @access Private (Student)
 */
const unenrollStudentFromSession = async (req, res) => {
  try {
    const { id: scheduleId } = req.params;
    const studentId = req.user.id;

    const schedule = await Schedule.findById(scheduleId);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    // Check if enrolled
    const isEnrolled = await isStudentEnrolledInSession(scheduleId, studentId);
    if (!isEnrolled) {
      return res.status(400).json({
        success: false,
        message: 'You are not enrolled in this session'
      });
    }

    // Unenroll
    if (schedule.sessionType === 'one-on-one') {
      if (String(schedule.student) === String(studentId)) {
        schedule.student = null;
      }
    } else {
      schedule.students = (schedule.students || []).filter(
        sid => String(sid) !== String(studentId)
      );
    }

    await schedule.save();

    // Log audit
    logAudit({
      req,
      userId: studentId,
      action: 'Unenroll from Session',
      module: 'Academic',
      description: `Student unenrolled from ${schedule.sessionType} session`,
      status: 'SUCCESS',
      metadata: {
        scheduleId,
        sessionType: schedule.sessionType
      }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Successfully unenrolled from session'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to unenroll from session'
    });
  }
};

/**
 * Get student's enrolled sessions
 * @route GET /api/sessions/my-sessions
 * @access Private (Student)
 * Query params: { fromDate, toDate }
 */
const getStudentSessions = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { fromDate, toDate } = req.query;

    const query = {
      $or: [
        { student: studentId },
        { students: studentId }
      ]
    };

    // Filter by date range
    if (fromDate || toDate) {
      query.date = {};
      if (fromDate) {
        const from = new Date(fromDate + 'T00:00:00.000Z');
        if (!isNaN(from.getTime())) {
          query.date.$gte = from;
        }
      }
      if (toDate) {
        const to = new Date(toDate + 'T23:59:59.999Z');
        if (!isNaN(to.getTime())) {
          query.date.$lte = to;
        }
      }
    }

    const sessions = await Schedule.find(query)
      .populate('tutor', 'firstName lastName email')
      .populate('subject', 'name code')
      .populate('tutoringAreaId', 'name areaType')
      .sort({ date: 1, startTime: 1 })
      .lean();

    // Add useful fields
    const enrichedSessions = sessions.map(session => ({
      ...session,
      dayName: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][session.dayOfWeek],
      currentEnrollment: session.sessionType === 'one-on-one'
        ? 1
        : (Array.isArray(session.students) ? session.students.length : 0)
    }));

    res.status(200).json({
      success: true,
      sessions: enrichedSessions,
      count: sessions.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to retrieve your sessions'
    });
  }
};

module.exports = {
  getAvailableSessionsForStudents,
  enrollStudentInSession,
  unenrollStudentFromSession,
  getStudentSessions
};
