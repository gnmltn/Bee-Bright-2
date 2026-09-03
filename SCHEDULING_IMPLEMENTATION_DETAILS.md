# Scheduling Policy Update

The scheduler now uses program-driven rules: Academic Tutorial and Examination Preparation require one child, one tutor, and a two-hour slot; Toddlers Playgroup is a shared two-hour session with 1-10 children and 5-6 tutors. All sessions run Monday-Saturday between 8:00 AM and 5:00 PM, excluding the 12:00 PM-1:00 PM lunch break. Parent preferred date/time is a constraint and must not be silently ignored. Playgroups are stored as one schedule row with `tutors[]`.

# BeeBright Scheduling System - Implementation Details

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    API Requests (Admin)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│            scheduleRoutes.js (Route Handlers)               │
│  ┌─ POST /api/schedules                                    │
│  ├─ POST /api/schedules/:id/enroll-student                 │
│  ├─ POST /api/schedules/:id/remove-student                 │
│  └─ Other existing routes (unchanged)                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│        scheduleController.js (Business Logic)                │
│  ┌─ createSchedule()              (Enhanced)                │
│  ├─ enrollStudentInSession()      (New)                     │
│  ├─ removeStudentFromSession()    (New)                     │
│  ├─ hasStudentScheduleConflict()  (New Helper)              │
│  ├─ isStudentEnrolled()           (New Helper)              │
│  ├─ getSessionEnrollmentCount()   (New Helper)              │
│  └─ Other functions (mostly unchanged)                       │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                          │                                  │
│  ┌─────────────────────────▼──────────────┐                │
│  │ sessionTypeManager.js (Config)         │                │
│  │ • SESSION_TYPES configuration          │                │
│  │ • getSessionType()                     │                │
│  │ • getMaxCapacity()                     │                │
│  │ • canAddStudent()                      │                │
│  │ • getCurrentEnrollment()                │                │
│  └────────────────────────────────────────┘                │
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐
│  │            Schedule Model (MongoDB)                      │
│  │ • sessionType (enum)                                   │
│  │ • student (ObjectId - 1-on-1)                          │
│  │ • students (Array - Group)                             │
│  │ • maxCapacity (number)                                 │
│  │ • tutor, subject, date, time (existing)                │
│  │ • Indexes: date+startTime (unique)                     │
│  └─────────────────────────────────────────────────────────┘
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐
│  │         Supporting Models (Existing)                    │
│  │ • User (students, tutors, admins)                      │
│  │ • Enrollment (student-subject mapping)                 │
│  │ • Subject (course information)                         │
│  │ • TutorUnavailability                                  │
│  └─────────────────────────────────────────────────────────┘
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Session Type Manager Module

**File**: `/backend/utils/sessionTypeManager.js`

### Configuration Structure

```javascript
SESSION_TYPES = {
  ONE_ON_ONE: {
    type: 'one-on-one',           // Email enum value
    name: 'One-on-One Session',   // Display name
    maxCapacity: 1,               // Maximum students
    description: '1 tutor : 1 student'
  },
  SMALL_GROUP: {
    type: 'small-group',
    name: 'Small Group Session',
    maxCapacity: 3,
    description: '1 tutor : up to 3 students'
  },
  PLAYGROUP: {
    type: 'playgroup',
    name: 'Playgroup Session',
    maxCapacity: 10,
    description: '1 tutor : up to 10 students (toddlers/early learning)'
  }
}
```

### Exported Functions

```javascript
// Get config by type string
getSessionType(type: string): Object | null

// Get one-on-one config (default)
getDefaultSessionType(): Object

// Get all session types
getAllSessionTypes(): Array

// Validate session type exists
isValidSessionType(type: string): boolean

// Get max capacity for type
getMaxCapacity(type: string): number

// Check if at capacity
isAtCapacity(
  currentEnrollment: number,
  maxCapacity: number
): boolean

// Check if can add student
canAddStudent(
  currentEnrollment: number,
  maxCapacity: number
): { ok: boolean, reason: string }

// Count enrolled students
getCurrentEnrollment(students: Array): number
```

## Schedule Model Updates

**File**: `/backend/models/Schedule.js`

### New Fields

```javascript
// Session type determines capacity
sessionType: {
  type: String,
  enum: ['one-on-one', 'small-group', 'playgroup'],
  default: 'one-on-one'
}

// For backward compatibility with 1-on-1
student: {
  type: ObjectId,
  ref: 'User',
  default: null
}

// For group sessions
students: [{
  type: ObjectId,
  ref: 'User'
}]

// Auto-set based on session type
maxCapacity: {
  type: Number,
  default: 1
}
```

### Index Changes

```javascript
// Existing (unchanged)
scheduleSchema.index({ date: 1, startTime: 1 }, { unique: true });
scheduleSchema.index({ date: 1, startTime: 1 }, { unique: true, sparse: true });

// Updated for backward compatibility
scheduleSchema.index({ student: 1, tutor: 1, subject: 1, date: 1, startTime: 1 }, 
  { unique: true, sparse: true }  // sparse: true allows null student for group sessions
);

// New for group sessions
scheduleSchema.index({ students: 1, createdAt: -1 });
```

## Enhanced createSchedule Function

**File**: `/backend/controllers/scheduleController.js`

### Request Schema

```javascript
{
  studentId?: string,        // Optional (required for 1-on-1 without students array)
  students?: string[],       // Optional (for group sessions)
  tutorId: string,          // Required
  subjectId: string,        // Required
  date: string,             // Required (YYYY-MM-DD)
  startTime: string,        // Required (HH:MM)
  endTime: string,          // Required (HH:MM)
  sessionType?: string      // Optional (one-on-one|small-group|playgroup)
}
```

### Validation Steps (In Order)

```javascript
1. Validate required fields (tutorId, subjectId, date, startTime, endTime)
   └─ Return 400 if missing

2. Determine session type (default to 'one-on-one')
   ├─ Validate sessionType exists
   └─ Get maxCapacity from config

3. Validate and normalize students list
   ├─ For one-on-one: use studentId
   ├─ For groups: use students array
   └─ Check capacity not exceeded

4. Validate date
   ├─ Parse as UTC
   ├─ Cannot be in past
   └─ Return 400 if invalid

5. Validate tutor
   ├─ Exists and active
   ├─ Can teach subject
   └─ Return 400 if not

6. Check tutor schedule
   ├─ Not marked unavailable on date
   ├─ No other session at this time
   └─ Return 400 if conflict

7. For each student
   ├─ Has active enrollment
   ├─ Enrolled in subject
   ├─ No conflicting schedule
   └─ Return 400 if any issue

8. Validate room availability
   ├─ Check unique (date, startTime) index
   ├─ No other session at this slot
   └─ Return 400 if booked

9. For one-on-one only
   ├─ Check no duplicate assignment
   └─ Return 400 if exists

10. Create schedule document
    ├─ Set all fields correctly
    ├─ Populate references
    └─ Return 201 with populated schedule
```

## New Endpoints

### enrollStudentInSession()

**Route**: `POST /api/schedules/:id/enroll-student`  
**Auth**: Admin only

**Request Body**:
```javascript
{ studentId: string }
```

**Validation Chain**:
```
1. Parse scheduleId from params
2. Validate studentId provided
3. Get schedule (lean)
4. Validate session exists
5. Get session type config
6. Count current enrollment
7. Check capacity
8. Check not already enrolled
9. Validate enrollment status
10. Validate subject enrollment
11. Check schedule conflicts
12. Update with $addToSet (prevents duplicates)
13. Log audit
14. Return updated schedule
```

**Response**:
```javascript
{
  success: true,
  message: "Student enrolled successfully",
  schedule: { ...populated schedule },
  enrollmentCount: number,
  capacity: number
}
```

**Errors**:
- 400: Capacity exceeded, already enrolled, no enrollment, subject mismatch, time conflict
- 404: Session not found
- 500: Internal error

### removeStudentFromSession()

**Route**: `POST /api/schedules/:id/remove-student`  
**Auth**: Admin only

**Request Body**:
```javascript
{ studentId: string }
```

**Validation Chain**:
```
1. Parse scheduleId from params
2. Validate studentId provided
3. Get schedule (lean)
4. Validate session exists
5. Check is group session (not one-on-one)
6. Check student is enrolled
7. Update with $pull (removes matching)
8. Log audit
9. Return updated schedule
```

**Response**:
```javascript
{
  success: true,
  message: "Student removed successfully",
  schedule: { ...populated schedule },
  enrollmentCount: number,
  capacity: number
}
```

**Errors**:
- 400: Cannot remove from 1-on-1, student not enrolled
- 404: Session not found
- 500: Internal error

## Helper Functions

### hasStudentScheduleConflict()

```javascript
/**
 * Detects if student has overlapping session
 * @param {string} studentId
 * @param {Date} date
 * @param {string} startTime
 * @param {string} endTime (optional)
 * @param {string} excludeScheduleId (optional)
 * @returns {Promise<boolean>}
 */
async function hasStudentScheduleConflict({
  studentId,
  date,
  startTime,
  endTime,
  excludeScheduleId = null
})

// Implementation
const query = {
  date,
  startTime: normalizeTime(startTime),
  $or: [
    { student: studentId },      // 1-on-1 check
    { students: studentId }      // Group check
  ]
};

if (excludeScheduleId) {
  query._id = { $ne: excludeScheduleId };
}

return Schedule.exists(query);
```

### isStudentEnrolled()

```javascript
/**
 * Checks if student already in session
 * @param {string} scheduleId
 * @param {string} studentId
 * @returns {Promise<boolean>}
 */
async function isStudentEnrolled(scheduleId, studentId)

// Implementation
const schedule = await Schedule.findById(scheduleId)
  .select('student students')
  .lean();

// Check both fields for maximum compatibility
if (String(schedule.student) === String(studentId)) return true;
if (schedule.students?.some(uid => String(uid) === String(studentId))) return true;

return false;
```

### getSessionEnrollmentCount()

```javascript
/**
 * Gets current enrollment for session
 * @param {string} scheduleId
 * @returns {Promise<number>}
 */
async function getSessionEnrollmentCount(scheduleId)

// Implementation
const schedule = await Schedule.findById(scheduleId)
  .select('student students sessionType')
  .lean();

if (schedule.sessionType === 'one-on-one') {
  return schedule.student ? 1 : 0;
}

return Array.isArray(schedule.students) ? schedule.students.length : 0;
```

## Data Consistency Patterns

### Creating a Schedule (Transaction-like Flow)

```javascript
1. Validate all inputs
2. Check all constraints (room, tutor, students)
3. Create schedule document atomically
4. Populate references
5. Log audit
6. Return to client
```

### Enrolling Student (Atomic Array Update)

```javascript
// Uses MongoDB $addToSet to prevent duplicates
await Schedule.findByIdAndUpdate(
  scheduleId,
  { $addToSet: { students: studentId } },  // Fails silently if already exists
  { new: true }
);

// If using this pattern, also check enrollment manually first
// to provide better error messages to client
```

### Removing Student (Atomic Array Update)

```javascript
// Uses MongoDB $pull to remove from array
await Schedule.findByIdAndUpdate(
  scheduleId,
  { $pull: { students: studentId } },  // Removes all occurrences
  { new: true }
);

// Note: $pull silently succeeds if element not in array
// So always check enrollment first for better UX
```

## Migration & Rollout Strategy

### Phase 1: Backward Compatibility
- Schema changes deployed
- All new fields have defaults
- Existing 1-on-1 schedules unaffected
- New code checks `sessionType` but defaults to 'one-on-one'

### Phase 2: New Feature Introduction
- Admins can create group sessions
- Students enrolled via new endpoints
- Existing workflows unchanged

### Phase 3: Monitoring
- Track group session usage
- Monitor for conflicts mistakes
- Verify no data corruption

### Phase 4: Documentation
- Update admin UI tutorials
- Create user guides
- Share best practices

## Performance Optimizations

### Current Implementation
- Validation checks are mostly sequential
- Queries are indexed appropriately
- No N+1 problems identified

### Potential Improvements
1. **Batch Enrollment**: Add endpoint to enroll multiple students at once
2. **Query Optimization**: Cache session type configs
3. **Conflict Detection**: Could pre-filter by date instead of querying all
4. **Lazy Loading**: Don't populate full objects until needed

## Testing Strategy

### Unit Tests (Controller Functions)
```javascript
describe('createSchedule', () => {
  // Test one-on-one creation
  // Test small-group creation
  // Test playgroup creation
  // Test capacity enforcement
  // Test conflict detection
  // Test validation errors
});

describe('enrollStudentInSession', () => {
  // Test successful enrollment
  // Test capacity exceeded
  // Test duplicate enrollment
  // Test missing enrollment
  // Test subject mismatch
  // Test schedule conflict
});

describe('removeStudentFromSession', () => {
  // Test successful removal
  // Test not enrolled error
  // Test one-on-one prevention
});

describe('Conflict Detection', () => {
  // Test room conflicts
  // Test tutor conflicts
  // Test student conflicts
  // Test no false positives
});
```

### Integration Tests
- Create session, enroll students, verify counts
- Create overlapping sessions, verify rejection
- Test backward compatibility with 1-on-1
- Check audit logs are created

### Manual Testing
- Use Postman/Insomnia to test endpoints
- Verify UI updates for group sessions
- Check database transactions complete
- Verify error messages display correctly

## Monitoring & Logging

### Audit Logs Track

```javascript
// Create Session
{
  action: 'Create Schedule',
  module: 'Academic',
  description: 'Admin created one-on-one|small-group|playgroup session',
  metadata: { sessionType, studentCount, tutorId, subjectId }
}

// Enroll Student
{
  action: 'Enroll Student in Session',
  module: 'Academic',
  description: 'Admin enrolled student in group session',
  metadata: { scheduleId, studentId, sessionType }
}

// Remove Student
{
  action: 'Remove Student from Session',
  module: 'Academic',
  description: 'Admin removed student from group session',
  metadata: { scheduleId, studentId, sessionType }
}
```

### Error Monitoring
- Track enrollment failures (capacity, conflicts)
- Monitor validation errors
- Alert on unusual patterns

## Backward Compatibility Guarantees

1. ✓ Old API calls work unchanged
2. ✓ Existing schedules unaffected
3. ✓ Database queries backward compatible
4. ✓ Indexes don't break old queries
5. ✓ Default behavior unchanged (one-on-one)
6. ✓ No data migration needed
7. ✓ No breaking changes to responses
8. ✓ Additional fields are optional

## Future Extensibility

### Adding New Session Types

1. Update `SESSION_TYPES` in `sessionTypeManager.js`
2. Add validation in `createSchedule()` if needed
3. No database changes required
4. Works immediately with new capacity

Example:
```javascript
SEMI_PRIVATE: {
  type: 'semi-private',
  name: 'Semi-Private Session',
  maxCapacity: 2,
  description: '1 tutor : up to 2 students'
}
```

### Adding Time-Based Conflict Detection

Currently checks `startTime` only (date + startTime unique).

To handle overlapping times:
```javascript
// Check if any session overlaps with requested time
async function hasTimeOverlap({ date, startTime, endTime }) {
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  
  return Schedule.exists({
    date,
    $or: [
      { startTime: { $lt: end }, endTime: { $gt: start } }
    ]
  });
}
```

---

**Document Version**: 1.0  
**Last Updated**: March 29, 2026  
**Compatibility**: MongoDB, Node.js 14+
