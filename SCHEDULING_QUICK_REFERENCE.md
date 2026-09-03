# Current Scheduling Policy

- Operating days: Monday-Saturday, 8:00 AM-5:00 PM.
- Lunch is blocked from 12:00 PM-1:00 PM.
- Academic Tutorial and Examination Preparation are one-on-one sessions of exactly two hours (8-10, 10-12, 1-3, or 3-5).
- Toddlers Playgroup is one shared session from 8:00 AM-10:00 AM or 1:00 PM-3:00 PM, with 1-10 children and 5-6 co-tutors stored on a single schedule.
- Parent preferred start date/time is respected during manual and recurring schedule creation.
- All active tutors are eligible for every program; legacy `subjectsTaught` values are retained for compatibility only.

# BeeBright Scheduling System - Quick Reference Guide

## Session Types at a Glance

| Feature | One-on-One | Small Group | Playgroup |
|---------|-----------|------------|-----------|
| **Type Code** | `one-on-one` | `small-group` | `playgroup` |
| **Max Students** | 1 | 3 | 10 |
| **Best For** | Individual tutoring | Peer learning | Early childhood |
| **Subject Examples** | Any | Any | Toddlers Playgroup, Pre-K |
| **Capacity Strict?** | Yes | Yes | Yes |
| **Backward Compatible?** | Yes (default) | New | New |

## Common Tasks

### Create One-on-One Session (Same as Before)
```
POST /api/schedules
{
  "studentId": "student123",
  "tutorId": "tutor456",
  "subjectId": "subject789",
  "date": "2026-03-29",
  "startTime": "10:00",
  "endTime": "12:00"
}
```

### Create Small Group Session (NEW)
```
POST /api/schedules
{
  "students": ["student1", "student2", "student3"],
  "tutorId": "tutor456",
  "subjectId": "subject789",
  "date": "2026-03-29",
  "startTime": "14:00",
  "endTime": "16:00",
  "sessionType": "small-group"
}
```

### Create Playgroup Session (shared tutors)
```
POST /api/schedules
{
  "students": ["s1", "s2", "s3", "s4", "s5"],
  "tutorIds": ["tutor1", "tutor2", "tutor3", "tutor4", "tutor5"],
  "subjectId": "playgroup_subject",
  "date": "2026-03-29",
  "startTime": "08:00",
  "endTime": "10:00",
  "sessionType": "playgroup"
}
```

### Add Student to Group Session (NEW)
```
POST /api/schedules/{sessionId}/enroll-student
{
  "studentId": "newstudent"
}
```

### Remove Student from Group Session (NEW)
```
POST /api/schedules/{sessionId}/remove-student
{
  "studentId": "student_to_remove"
}
```

## Why Sessions Might Be Rejected

| Error | Reason | Solution |
|-------|--------|----------|
| "Room is already occupied at this time" | Another session booked | Choose different time |
| "Tutor already has another session" | Tutor busy | Choose different time or tutor |
| "Student has a conflicting schedule" | Student busy | Choose different student or time |
| "Session is at capacity" | Too many students | Remove a student first |
| "Student is already enrolled" | Duplicate enrollment | Check roster first |
| "Student has no active enrollment" | Not registered | Complete enrollment first |
| "Student is not enrolled in subject" | Wrong subject | Verify subject enrollment |

## Workflow Examples

### Scenario 1: Growing One-on-One into Small Group
1. Start with one-on-one: student A + tutor Z
2. Want to add student B to same tutor/subject/time
3. **Solution**: Cannot modify existing session. Delete one-on-one, create small-group with both.

### Scenario 2: Managing Playgroup Enrollments
1. Create playgroup with 5 students
2. Student 6 joins: `POST .../enroll-student` → Success (capacity 6/10)
3. Student 7 joins: `POST .../enroll-student` → Success (capacity 7/10)
4. Student 8 joins: `POST .../enroll-student` → Success (capacity 8/10)
5. **Full**: No more enrollments possible (at 10/10)
6. Remove student 2: `POST .../remove-student` → Success (capacity 9/10)
7. Student 9 joins: `POST .../enroll-student` → Success (capacity 10/10)

### Scenario 3: Subject Mismatch Issue
1. Try to add student to Math Small Group
2. Error: "Student is not enrolled in this subject"
3. **Check**: Is student enrolled in Math? If yes, check if enrolled in right term.
4. **Resolution**: Have student enroll in Math before adding to group.

### Scenario 4: Schedule Conflict
1. Student attending 10:00-12:00 Tutor A session
2. Try to add same student to 10:00-12:00 Tutor B group
3. **Result**: Error "Student has a conflicting schedule"
4. **Why**: Can't be in two places at once!

## Tips for Admins

### ✓ DO
- Create specific playgroup subject code (e.g., "TPG101" for Toddlers Playgroup)
- Start groups small, add students as they enroll
- Verify student active enrollment before adding
- Check tutor availability for group sessions
- Use one-on-one for high-need students
- Use small groups for peer collaboration
- Removestudents from groups if they need to leave

### ✗ DON'T
- Try to change session type (delete and recreate instead)
- Add students to full sessions (remove one first)
- Schedule groups with students on conflicting times
- Schedule without checking room availability
- Add students without `small-group` or `playgroup` type
- Force one-on-one when group makes sense

## Key Numbers to Remember

| Session Type | Max Capacity | Typical Duration |
|-------------|-------------|------------------|
| One-on-One | **1** | 2 hours |
| Small Group | **3** | 2 hours |
| Playgroup | **10** | 2 hours |

## Troubleshooting Quick Links

**"Room already booked at this time?"**
- Check if another session exists for 10:00 timestart on same date
- Room is shared resource - one session per date + startTime
- Solution: Pick different time or date

**"Tutor conflict?"**
- Tutor can't teach multiple classes simultaneously
- Check tutor schedule for that day
- Solution: Pick different tutor or time

**"Student conflict?"**
- One student can't be two places at once
- Student may already have session at that time
- Solution: Pick different time or different student

**"Session full?"**
- One-on-one max 1, small-group max 3, playgroup max 10
- Solution: Remove a student OR check they're already enrolled

**"Enrollment error?"**
- Student must have active enrollment
- Student must be enrolled in the specific subject
- Solution: Complete student registration first

## Monthly Monitoring Checklist

- [ ] Review all group sessions created
- [ ] Check attendance rates for groups vs 1-on-1
- [ ] Monitor for conflict patterns
- [ ] Verify tutor satisfaction with group formats
- [ ] Collect student feedback on group sessions
- [ ] Adjust capacity or session types as needed
- [ ] Maintain audit logs for compliance

## Emergency Contacts

**System Issues**: Contact IT Support  
**Enrollment Problems**: Verify student active status with Enrollment team  
**Subject Questions**: Check Subject Catalog in settings  
**Tutor Availability**: Review TutorUnavailability records  

---

**For detailed technical information**: See SCHEDULING_UPGRADE_GUIDE.md  
**For developer details**: See SCHEDULING_IMPLEMENTATION_DETAILS.md  
**Date Last Updated**: March 29, 2026
