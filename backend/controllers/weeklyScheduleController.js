/**
 * Weekly Schedule Management Controller (Admin)
 * 
 * Handles creation and management of weekly schedule templates
 * and generation of sessions from templates
 */

const mongoose = require('mongoose');
const Schedule = require('../models/Schedule');
const WeeklyScheduleTemplate = require('../models/WeeklyScheduleTemplate');
const TutoringArea = require('../models/TutoringArea');
const User = require('../models/User');
const Subject = require('../models/Subject');
const { logAudit } = require('../utils/auditService');
const {
  validateRoomAssignment,
  isTutorDoubleBooked,
  isRoomDoubleBooked,
  normalizeTime,
  getDateForWeekDay,
  validateTemplateEntry,
  DAYS_OF_WEEK,
  DAY_INDEXES
} = require('../utils/weeklySchedulingUtils');
const { getSessionType, getMaxCapacity } = require('../utils/sessionTypeManager');

/**
 * Get options needed for weekly scheduling UI
 * @route GET /api/admin/weekly-schedules/options
 * @access Private (Admin)
 */
const getWeeklyScheduleOptions = async (req, res) => {
  try {
    // Ensure required room types exist so inline scheduling works out of the box.
    const existingTutoringArea = await TutoringArea.findOne({ areaType: 'tutoring_area' }).lean();
    if (!existingTutoringArea) {
      await TutoringArea.create({
        name: 'Main Tutoring Area',
        areaType: 'tutoring_area',
        capacity: 15,
        isActive: true,
        description: 'Default tutoring area for 1-on-1 and small-group sessions'
      });
    }

    const existingToddlerRoom = await TutoringArea.findOne({ areaType: 'toddler_room' }).lean();
    if (!existingToddlerRoom) {
      await TutoringArea.create({
        name: 'Toddler Room',
        areaType: 'toddler_room',
        capacity: 10,
        isActive: true,
        description: 'Default room for toddler playgroup sessions'
      });
    }

    const [tutoringAreas, tutors, subjects] = await Promise.all([
      TutoringArea.find({ isActive: true })
        .select('name areaType capacity isActive')
        .sort({ areaType: 1, name: 1 })
        .lean(),
      User.find({ role: 'tutor', isArchived: { $ne: true } })
        .select('firstName middleName lastName email subjectsTaught isActive')
        .populate('subjectsTaught', 'name code')
        .sort({ firstName: 1, lastName: 1 })
        .lean(),
      Subject.find({ isActive: true })
        .select('name code isActive')
        .sort({ name: 1 })
        .lean()
    ]);

    res.status(200).json({
      success: true,
      tutoringAreas,
      tutors,
      subjects
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load weekly scheduling options'
    });
  }
};

/**
 * Create a new weekly schedule template
 * @route POST /api/admin/weekly-schedules
 * @access Private (Admin)
 */
const createWeeklyScheduleTemplate = async (req, res) => {
  try {
    const {
      name,
      description,
      effectiveStartDate,
      effectiveEndDate,
      scheduleEntries
    } = req.body;

    // Validate required fields
    if (!name || !effectiveStartDate || !scheduleEntries || scheduleEntries.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'name, effectiveStartDate, and scheduleEntries are required'
      });
    }

    // Validate effective dates
    const startDate = new Date(effectiveStartDate);
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid effectiveStartDate'
      });
    }

    if (effectiveEndDate) {
      const endDate = new Date(effectiveEndDate);
      if (isNaN(endDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid effectiveEndDate'
        });
      }

      if (endDate < startDate) {
        return res.status(400).json({
          success: false,
          message: 'effectiveEndDate must be after effectiveStartDate'
        });
      }
    }

    // Validate and normalize schedule entries
    const validatedEntries = [];
    for (const entry of scheduleEntries) {
      const { dayOfWeek, startTime, endTime, tutorId, sessionType, tutoringAreaId, subjectId } = entry;

      // Validate entry fields
      if (dayOfWeek == null || !startTime || !endTime || !tutorId || !sessionType || !tutoringAreaId || !subjectId) {
        return res.status(400).json({
          success: false,
          message: 'Each schedule entry must have: dayOfWeek, startTime, endTime, tutorId, sessionType, tutoringAreaId, subjectId'
        });
      }

      // Validate dayOfWeek (0-5 for Monday-Saturday)
      const dow = Number(dayOfWeek);
      if (isNaN(dow) || dow < 0 || dow > 5) {
        return res.status(400).json({
          success: false,
          message: `Invalid dayOfWeek: ${dayOfWeek}. Must be 0-5 (Monday-Saturday)`
        });
      }

      // Validate session type
      if (!getSessionType(sessionType)) {
        return res.status(400).json({
          success: false,
          message: `Invalid sessionType: ${sessionType}`
        });
      }

      // Validate tutor exists and can teach subject
      const tutor = await User.findOne({
        _id: tutorId,
        role: 'tutor',
        subjectsTaught: subjectId
      }).lean();

      if (!tutor) {
        return res.status(400).json({
          success: false,
          message: `Tutor not found or cannot teach subject`
        });
      }

      // Validate tutoring area
      const area = await TutoringArea.findById(tutoringAreaId).lean();
      if (!area) {
        return res.status(400).json({
          success: false,
          message: `Tutoring area not found`
        });
      }

      // Validate room assignment rules
      const roomCheck = await validateRoomAssignment(sessionType, tutoringAreaId);
      if (!roomCheck.ok) {
        return res.status(400).json({
          success: false,
          message: roomCheck.reason
        });
      }

      // Check for template conflicts
      const conflictCheck = await validateTemplateEntry(
        tutorId,
        dow,
        normalizeTime(startTime),
        tutoringAreaId,
        startDate
      );

      if (!conflictCheck.ok) {
        return res.status(400).json({
          success: false,
          message: conflictCheck.reason
        });
      }

      validatedEntries.push({
        dayOfWeek: dow,
        startTime: normalizeTime(startTime),
        endTime: normalizeTime(endTime),
        tutorId,
        sessionType,
        tutoringAreaId,
        subjectId,
        isActive: true,
        notes: entry.notes || ''
      });
    }

    // Create template
    const template = await WeeklyScheduleTemplate.create({
      name,
      description: description || '',
      createdBy: req.user.id,
      effectiveStartDate: startDate,
      effectiveEndDate: effectiveEndDate ? new Date(effectiveEndDate) : null,
      scheduleEntries: validatedEntries,
      status: 'draft'
    });

    // Log audit
    logAudit({
      req,
      userId: req.user.id,
      action: 'Create Weekly Schedule Template',
      module: 'Scheduling',
      description: `Admin created weekly schedule template: ${name}`,
      status: 'SUCCESS',
      metadata: {
        templateId: template._id,
        entriesCount: validatedEntries.length
      }
    }).catch(() => {});

    const populated = await WeeklyScheduleTemplate.findById(template._id)
      .populate('createdBy', 'firstName lastName email')
      .populate('scheduleEntries.tutorId', 'firstName lastName email')
      .populate('scheduleEntries.tutoringAreaId', 'name areaType')
      .populate('scheduleEntries.subjectId', 'name code')
      .lean();

    res.status(201).json({
      success: true,
      message: 'Weekly schedule template created successfully',
      template: populated
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create weekly schedule template'
    });
  }
};

/**
 * Get all weekly schedule templates
 * @route GET /api/admin/weekly-schedules
 * @access Private (Admin)
 */
const listWeeklyScheduleTemplates = async (req, res) => {
  try {
    const { status, skip = 0, limit = 20 } = req.query;

    const query = {};
    if (status) {
      query.status = status;
    }

    const templates = await WeeklyScheduleTemplate.find(query)
      .populate('createdBy', 'firstName lastName email')
      .populate('scheduleEntries.tutorId', 'firstName lastName')
      .populate('scheduleEntries.tutoringAreaId', 'name areaType')
      .populate('scheduleEntries.subjectId', 'name code')
      .skip(Number(skip))
      .limit(Number(limit))
      .sort({ createdAt: -1 })
      .lean();

    const total = await WeeklyScheduleTemplate.countDocuments(query);

    res.status(200).json({
      success: true,
      templates,
      pagination: {
        total,
        skip: Number(skip),
        limit: Number(limit)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list weekly schedules'
    });
  }
};

/**
 * Get a specific weekly schedule template
 * @route GET /api/admin/weekly-schedules/:id
 * @access Private (Admin)
 */
const getWeeklyScheduleTemplate = async (req, res) => {
  try {
    const template = await WeeklyScheduleTemplate.findById(req.params.id)
      .populate('createdBy', 'firstName lastName email')
      .populate('scheduleEntries.tutorId', 'firstName lastName email')
      .populate('scheduleEntries.tutoringAreaId', 'name areaType isActive')
      .populate('scheduleEntries.subjectId', 'name code')
      .lean();

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    res.status(200).json({
      success: true,
      template
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get weekly schedule template'
    });
  }
};

/**
 * Activate a template (status = 'active')
 * @route PATCH /api/admin/weekly-schedules/:id/activate
 * @access Private (Admin)
 */
const activateWeeklyScheduleTemplate = async (req, res) => {
  try {
    const template = await WeeklyScheduleTemplate.findById(req.params.id);

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    template.status = 'active';
    await template.save();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Activate Weekly Schedule Template',
      module: 'Scheduling',
      description: `Admin activated template: ${template.name}`,
      status: 'SUCCESS',
      metadata: { templateId: template._id }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Template activated successfully',
      template
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to activate template'
    });
  }
};

/**
 * Archive a template (status = 'archived')
 * @route PATCH /api/admin/weekly-schedules/:id/archive
 * @access Private (Admin)
 */
const archiveWeeklyScheduleTemplate = async (req, res) => {
  try {
    const template = await WeeklyScheduleTemplate.findById(req.params.id);

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    template.status = 'archived';
    await template.save();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Archive Weekly Schedule Template',
      module: 'Scheduling',
      description: `Admin archived template: ${template.name}`,
      status: 'SUCCESS',
      metadata: { templateId: template._id }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Template archived successfully',
      template
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to archive template'
    });
  }
};

/**
 * Generate sessions from template for a specific week
 * @route POST /api/admin/weekly-schedules/:id/generate-sessions
 * @access Private (Admin)
 * Body: { weekStartDate: "YYYY-MM-DD", monthSpan?: 1|2|3 }
 */
const generateSessionsFromTemplate = async (req, res) => {
  try {
    const { weekStartDate } = req.body;
    const parsedMonthSpan = Number(req.body?.monthSpan ?? 1);
    const monthSpan = Number.isInteger(parsedMonthSpan) ? parsedMonthSpan : 1;

    if (!weekStartDate) {
      return res.status(400).json({
        success: false,
        message: 'weekStartDate is required'
      });
    }

    if (monthSpan < 1 || monthSpan > 3) {
      return res.status(400).json({
        success: false,
        message: 'monthSpan must be 1, 2, or 3'
      });
    }

    const template = await WeeklyScheduleTemplate.findById(req.params.id);

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    if (template.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'Only active templates can generate sessions'
      });
    }

    const startDate = new Date(weekStartDate + 'T00:00:00.000Z');
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid weekStartDate format'
      });
    }

    const generationEndDate = new Date(startDate);
    generationEndDate.setUTCMonth(generationEndDate.getUTCMonth() + monthSpan);

    const weekStartDates = [];
    const cursor = new Date(startDate);
    while (cursor < generationEndDate) {
      weekStartDates.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    // Create sessions for each template entry across selected month span.
    const createdSessions = [];
    const errors = [];

    for (const generationWeekStart of weekStartDates) {
      for (const entry of template.scheduleEntries) {
        if (!entry.isActive) continue;

        try {
          // Get the specific date for this day of week in the current generation week.
          const sessionDate = getDateForWeekDay(entry.dayOfWeek, generationWeekStart);

          // Check for conflicts again (in case things changed).
          const tutorConflict = await isTutorDoubleBooked(
            entry.tutorId,
            sessionDate,
            entry.startTime
          );

          if (tutorConflict) {
            errors.push(`Tutor conflict on ${DAY_INDEXES[entry.dayOfWeek]} (${sessionDate.toISOString().slice(0, 10)})`);
            continue;
          }

          const roomConflict = await isRoomDoubleBooked(
            entry.tutoringAreaId,
            sessionDate,
            entry.startTime
          );

          if (roomConflict) {
            errors.push(`Room conflict on ${DAY_INDEXES[entry.dayOfWeek]} (${sessionDate.toISOString().slice(0, 10)})`);
            continue;
          }

          // Create session.
          const sessionType = entry.sessionType;
          const maxCapacity = getMaxCapacity(sessionType);

          const session = await Schedule.create({
            tutor: entry.tutorId,
            subject: entry.subjectId,
            date: sessionDate,
            startTime: normalizeTime(entry.startTime),
            endTime: normalizeTime(entry.endTime),
            tutoringAreaId: entry.tutoringAreaId,
            dayOfWeek: entry.dayOfWeek,
            sessionType,
            maxCapacity,
            student: null,
            students: [],
            sessionSource: 'template_generated',
            weeklyScheduleTemplateEntryId: entry._id,
            isEnrollableByStudents: true,
            substitutionStatus: 'none'
          });

          createdSessions.push(session);
        } catch (error) {
          errors.push(`Error creating session for ${DAY_INDEXES[entry.dayOfWeek]}: ${error.message}`);
        }
      }
    }

    // Update template's lastGeneratedDate
    template.lastGeneratedDate = new Date();
    const lastGeneratedWeekStart = weekStartDates.length > 0 ? weekStartDates[weekStartDates.length - 1] : startDate;
    template.nextGenerationWeekStart = new Date(lastGeneratedWeekStart);
    template.nextGenerationWeekStart.setUTCDate(template.nextGenerationWeekStart.getUTCDate() + 7);
    await template.save();

    logAudit({
      req,
      userId: req.user.id,
      action: 'Generate Sessions from Template',
      module: 'Scheduling',
      description: `Admin generated ${createdSessions.length} sessions for ${monthSpan} month(s) starting ${weekStartDate}`,
      status: 'SUCCESS',
      metadata: {
        templateId: template._id,
        monthSpan,
        generatedCount: createdSessions.length,
        errorCount: errors.length
      }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: `Generated ${createdSessions.length} sessions for ${monthSpan} month(s)${errors.length > 0 ? ` (${errors.length} errors)` : ''}`,
      sessionsCreated: createdSessions.length,
      monthSpan,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate sessions'
    });
  }
};

/**
 * Delete a weekly schedule template
 * @route DELETE /api/admin/weekly-schedules/:id
 * @access Private (Admin)
 */
const deleteWeeklyScheduleTemplate = async (req, res) => {
  try {
    const template = await WeeklyScheduleTemplate.findByIdAndDelete(req.params.id);

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    logAudit({
      req,
      userId: req.user.id,
      action: 'Delete Weekly Schedule Template',
      module: 'Scheduling',
      description: `Admin deleted template: ${template.name}`,
      status: 'SUCCESS',
      metadata: { templateId: template._id }
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete template'
    });
  }
};

module.exports = {
  getWeeklyScheduleOptions,
  createWeeklyScheduleTemplate,
  listWeeklyScheduleTemplates,
  getWeeklyScheduleTemplate,
  activateWeeklyScheduleTemplate,
  archiveWeeklyScheduleTemplate,
  generateSessionsFromTemplate,
  deleteWeeklyScheduleTemplate
};
