# BeeBright Scheduling System - Upgrade Guide

## Overview

The BeeBright scheduling system has been upgraded to support multiple tutoring formats while maintaining complete backward compatibility with existing 1-on-1 sessions.

## Supported Session Types

### 1. One-on-One Session (Default)
- **Type Code**: `one-on-one`
- **Max Capacity**: 1 student
- **Description**: Traditional 1 tutor : 1 student format
- **Backward Compatible**: Yes - all existing sessions default to this type
- **Usage**: Perfect for individualized learning

### 2. Small Group Session
- **Type Code**: `small-group`
- **Max Capacity**: 3 students
- **Description**: 1 tutor : up to 3 students
- **Best For**: Collaborative learning, peer interaction
- **Requirements**: All students must have active enrollment in the same subject

### 3. Playgroup Session (Toddlers/Early Learning)
- **Type Code**: `playgroup`
- **Max Capacity**: 10 students
- **Description**: 1 tutor : up to 10 students for early learning
- **Best For**: Toddlers, pre-K, social development programs
- **Requirements**: Strict capacity limits to ensure quality care

## Architecture Changes

### Database Model Updates

#### New Schedule Fields

1. **sessionType** (enum)
   - Values: `'one-on-one'` | `'small-group'` | `'playgroup'`
   - Default: `'one-on-one'`
   - Purpose: Identifies the session type

2. **students** (array of ObjectIds)
   - Stores all enrolled student IDs for group sessions
   - Empty array for one-on-one sessions
   - Used for capacity tracking and conflict detection

3. **student** (ObjectId) - Backward Compatibility
   - Maintained for one-on-one sessions
   - Single student reference for legacy functionality
   - Both `student` and `students` can coexist

4. **maxCapacity** (number)
   - Auto-set based on sessionType
   - Used to enforce capacity limits
   - 1 for one-on-one, 3 for small-group, 10 for playgroup

### Validation Rules

#### Room Conflict Detection
- **Rule**: One room can only host one session at a specific time
- **Enforcement**: Unique index on `(date, startTime)`
- **Applies To**: All session types
- **Error Message**: "Room is already occupied at this time. Choose another slot."

#### Tutor Conflict Detection  
- **Rule**: One tutor cannot teach multiple sessions at the same time
- **Enforcement**: Check existing sessions for same tutor + date + startTime
- **Applies To**: All session types
- **Error Message**: "Tutor already has another session at this time"

#### Student Conflict Detection (NEW)
- **Rule**: A student cannot attend two sessions at the same time
- **Enforcement**: Check `student` field OR `students` array for conflicts
- **Applies To**: All session types
- **Error Message**: "Student has a conflicting schedule at this time"

#### Capacity Enforcement (NEW)
- **Rule**: Cannot add student to session that's at max capacity
- **Enforcement**: Compare current enrollment count against maxCapacity
- **Applies To**: Group sessions (one-on-one always has capacity 1)
- **Error Message**: "Session is at capacity (X student(s))"

#### Enrollment Validation (NEW)
- **Rule**: Student must have active enrollment in the subject
- **Enforcement**: Verify active Enrollment record with subject in selectedSubjects
- **Applies To**: All session types (existing + new)

## API Endpoints

### Existing Endpoints (Compatible with Updates)

#### Create Schedule
```
POST /api/schedules
Headers: Authorization
Body: {
  studentId: string,          // For one-on-one (optional if students provided)
  students: [string],         // For group sessions (optional)
  tutorId: string,            // Required
  subjectId: string,          // Required
  date: string (YYYY-MM-DD),  // Required
  startTime: string (HH:MM),  // Required
  endTime: string (HH:MM),    // Required
  sessionType: string         // Optional, defaults to 'one-on-one'
}

Response: {
  success: boolean,
  message: string,
  schedule: {
    _id: string,
    sessionType: string,
    student: object | null,
    students: [object],
    tutor: object,
    subject: object,
    date: timestamp,
    startTime: string,
    endTime: string,
    maxCapacity: number,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}
```

### New Endpoints for Group Sessions

#### Enroll Student in Session
```
POST /api/schedules/:id/enroll-student
Headers: Authorization
Body: {
  studentId: string  // Required
}

Response: {
  success: boolean,
  message: string,
  schedule: { ...schedule object },
  enrollmentCount: number,
  capacity: number
}

Error Responses:
- 400: "Session is at capacity (X student(s))"
- 400: "Student is already enrolled in this session"
- 400: "Student has no active enrollment"
- 400: "Student is not enrolled in this subject"
- 400: "Student has a conflicting schedule at this time"
- 404: "Session not found"
```

#### Remove Student from Session
```
POST /api/schedules/:id/remove-student
Headers: Authorization
Body: {
  studentId: string  // Required
}

Response: {
  success: boolean,
  message: string,
  schedule: { ...schedule object },
  enrollmentCount: number,
  capacity: number
}

Error Responses:
- 400: "Cannot remove student from one-on-one session. Delete the session instead."
- 400: "Student is not enrolled in this session"
- 404: "Session not found"
```

## Usage Examples

### Creating a One-on-One Session (Backward Compatible)
```javascript
// Old style (still works)
POST /api/schedules
{
  "studentId": "101",
  "tutorId": "201",
  "subjectId": "301",
  "date": "2026-03-29",
  "startTime": "10:00",
  "endTime": "12:00"
}

// New style with explicit type
POST /api/schedules
{
  "studentId": "101",
  "tutorId": "201",
  "subjectId": "301",
  "date": "2026-03-29",
  "startTime": "10:00",
  "endTime": "12:00",
  "sessionType": "one-on-one"
}
```

### Creating a Small Group Session
```javascript
POST /api/schedules
{
  "students": ["student1_id", "student2_id", "student3_id"],
  "tutorId": "tutor_id",
  "subjectId": "subject_id",
  "date": "2026-03-29",
  "startTime": "14:00",
  "endTime": "16:00",
  "sessionType": "small-group"
}
```

### Creating a Playgroup Session
```javascript
POST /api/schedules
{
  "students": ["s1", "s2", "s3", "s4", "s5"],
  "tutorId": "tutor_id",
  "subjectId": "subject_id",  // Usually "Toddlers Playgroup" subject
  "date": "2026-03-29",
  "startTime": "09:00",
  "endTime": "11:00",
  "sessionType": "playgroup"
}
```

### Adding a Student to Existing Group Session
```javascript
POST /api/schedules/{sessionId}/enroll-student
{
  "studentId": "new_student_id"
}

// Response shows updated list with new student enrolled
```

### Removing a Student from Group Session
```javascript
POST /api/schedules/{sessionId}/remove-student
{
  "studentId": "student_id_to_remove"
}
```

## Backward Compatibility

### Existing Data
- All existing 1-on-1 schedules continue to work unchanged
- Old schedules automatically default to `sessionType: 'one-on-one'`
- No data migration required
- The `student` field remains primary for one-on-one sessions

### API Compatibility
- Old `createSchedule` calls with just `studentId` work as before
- Defaults to one-on-one when `sessionType` is not provided
- `students` array field is optional for backward compatibility

### Conflict Detection
- Room conflicts continue to prevent double-booking
- Tutor conflicts continue to prevent overlaps
- NEW: Student conflicts now also prevented (improves system reliability)

## Validation Flow

```
CREATE SESSION REQUEST
│
├─ Validate Session Type (defaults to one-on-one)
│  └─ Get max capacity from session type config
│
├─ Validate Students
│  ├─ For 1-on-1: require single studentId
│  ├─ For Groups: require students array
│  └─ Validate capacity enforcement
│
├─ Validate Date/Time
│  └─ Cannot be in past
│
├─ Validate Tutor
│  ├─ Exists and active
│  ├─ Can teach subject
│  ├─ Not marked unavailable
│  └─ No tutor conflicts
│
├─ For Each Student
│  ├─ Has active enrollment
│  ├─ Enrolled in subject
│  └─ No student schedule conflicts
│
├─ Validate Room
│  └─ No other session at same date+startTime
│
└─ CREATE SCHEDULE ✓
```

## Error Messages

| Scenario | Error Message | HTTP Code |
|----------|--------------|-----------|
| Room double-booked | "Room is already occupied at this time. Choose another slot." | 400 |
| Tutor unavailable | "Tutor is marked unavailable on this date" | 400 |
| Tutor has conflict | "Tutor already has another session at this time" | 400 |
| Student has conflict | "Student has a conflicting schedule at this time" | 400 |
| Session at capacity | "Session is at capacity (X student(s))" | 400 |
| Student not enrolled | "Student has no active enrollment" | 400 |
| Subject mismatch | "Student is not enrolled in this subject" | 400 |
| Duplicate enrollment | "Student is already enrolled in this session" | 400 |
| Invalid session type | "Invalid session type" | 500 |

## Session Type Configuration

Located in: `/backend/utils/sessionTypeManager.js`

```javascript
{
  type: 'one-on-one',
  name: 'One-on-One Session',
  maxCapacity: 1,
  description: '1 tutor : 1 student'
}

{
  type: 'small-group',
  name: 'Small Group Session',
  maxCapacity: 3,
  description: '1 tutor : up to 3 students'
}

{
  type: 'playgroup',
  name: 'Playgroup Session',
  maxCapacity: 10,
  description: '1 tutor : up to 10 students (toddlers/early learning)'
}
```

To add new session types:
1. Update `SESSION_TYPES` in `sessionTypeManager.js`
2. Add validation in session creation
3. No database changes needed

## Helper Functions (Internal)

### Student Conflict Detection
```javascript
hasStudentScheduleConflict({ studentId, date, startTime, endTime, excludeScheduleId })
// Checks if student has existing session at same date+time
```

### Enrollment Check
```javascript
isStudentEnrolled(scheduleId, studentId)
// Verifies if student is already in this session
```

### Enrollment Count
```javascript
getSessionEnrollmentCount(scheduleId)
// Returns number of enrolled students
```

## Testing Checklist

- [ ] Create one-on-one session (backward compatibility)
- [ ] Create small group session with multiple students
- [ ] Create playgroup session with 10 students
- [ ] Try adding 11th student to playgroup (should fail)
- [ ] Try adding duplicate student (should fail)
- [ ] Try adding student with schedule conflict (should fail)
- [ ] Verify room double-booking prevention still works
- [ ] Verify tutor conflict detection still works
- [ ] Verify existing 1-on-1 schedules unchanged
- [ ] Remove student from group session
- [ ] Try removing student from one-on-one (should fail gracefully)
- [ ] Test audit logging for new operations

## Database Migration

**No migration required!** 

The new schema is backward compatible:
- Existing one-on-one schedules default `sessionType: 'one-on-one'`
- The `students` array is empty for existing records
- The `student` field continues to work as before
- Indexes are updated but compatible with existing data

## Performance Considerations

### Indexes
- `(date, startTime)` - Prevents room double-booking
- `(students) + createdAt` - Fast student session lookups
- Existing indexes remain unchanged

### Query Efficiency
- Student conflict detection uses OR query on both `student` and `students` fields
- Enrollment count is calculated on-demand (lightweight)
- Consider denormalizing count if performance issues arise

## Future Enhancements

1. **Duration-based Conflicts**: Detect overlapping time ranges (not just start time)
2. **Tutor-Subject Availability**: Cache subject teaching capabilities
3. **Dynamic Pricing**: Different rates for group vs 1-on-1
4. **Wait Lists**: Queue for full sessions
5. **Session Templates**: Pre-configured group schedules
6. **Reporting**: Group session attendance and engagement metrics

## Troubleshooting

### Issue: "Room is already occupied" when should be available
- Check times are normalized (HH:MM format)
- Verify no overlapping sessions
- Check room booking index integrity

### Issue: Student can't enroll but should be
- Verify student has active enrollment
- Verify student is enrolled in subject
- Check no conflicting schedule exists
- Confirm session not at capacity

### Issue: Old 1-on-1 sessions broken
- Should not happen (backward compatible)
- Verify `sessionType` defaults to 'one-on-one'
- Check `student` field is populated for old sessions
- Inspect audit logs for recent changes

## Support & Maintenance

### Code Locations
- **Model**: `/backend/models/Schedule.js`
- **Session Types**: `/backend/utils/sessionTypeManager.js`  
- **Validation**: `/backend/controllers/scheduleController.js`
- **Routes**: `/backend/routes/scheduleRoutes.js`

### Key Functions
- `createSchedule()` - Main session creation
- `enrollStudentInSession()` - Add student to group
- `removeStudentFromSession()` - Remove from group
- `hasStudentScheduleConflict()` - Conflict check
- `isStudentEnrolled()` - Enrollment check

---

**Version**: 1.0  
**Status**: Production  
**Backward Compatible**: Yes  
**Last Updated**: March 29, 2026
