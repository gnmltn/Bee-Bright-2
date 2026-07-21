# BeeBright Scheduling System - Deployment Checklist

## Pre-Deployment Verification

### Code Quality
- [x] No syntax errors in modified files
- [x] All new functions properly exported
- [x] Routes properly defined
- [x] Error handling implemented
- [x] Validation logic complete

### File Modifications Summary

**Files Created**:
1. `/backend/utils/sessionTypeManager.js` - Session type configuration (NEW)
2. `/backend/SCHEDULING_UPGRADE_GUIDE.md` - User documentation (NEW)
3. `/SCHEDULING_IMPLEMENTATION_DETAILS.md` - Developer documentation (NEW)
4. `/SCHEDULING_QUICK_REFERENCE.md` - Admin quick reference (NEW)
5. `/Deployment Checklist.md` - This file (NEW)

**Files Modified**:
1. `/backend/models/Schedule.js` - Added session type fields
2. `/backend/controllers/scheduleController.js` - Enhanced create, added enroll/remove functions
3. `/backend/routes/scheduleRoutes.js` - Added new endpoints
4. `/backend/utils/sessionTypeManager.js` - Created new utility module

### Backward Compatibility Verification
- [x] One-on-one sessions default to `sessionType: 'one-on-one'`
- [x] `student` field maintained for backward compatibility
- [x] Existing unique indexes updated (sparse: true for null student)
- [x] New `students` array parallel to existing `student`
- [x] Old API calls work unchanged
- [x] No data migration required
- [x] Default behavior unchanged when `sessionType` omitted

## Deployment Steps

### Step 1: Backup Database
```bash
# Before any changes, backup MongoDB
mongodump --db beebright --out /backup/$(date +%Y%m%d_%H%M%S)

# Verify backup
ls -la /backup/
```

### Step 2: Deploy Code
```bash
# Pull latest code
git pull origin main

# Backend files updated:
# - backend/models/Schedule.js
# - backend/controllers/scheduleController.js
# - backend/routes/scheduleRoutes.js
# - backend/utils/sessionTypeManager.js (NEW)
```

### Step 3: No Database Migration Needed
```
✓ Schema backward compatible
✓ Index changes applied automatically
✓ Existing data unaffected
✓ New fields have defaults
```

### Step 4: Restart Services
```bash
# If using PM2
pm2 restart all

# If using node directly
# Kill process and restart

# Verify server is running
curl http://localhost:5000/api/schedules/options
```

### Step 5: Smoke Test (Manual)
```javascript
// Test 1: Create one-on-one (backward compatible)
POST /api/schedules
{
  "studentId": "test_student",
  "tutorId": "test_tutor",
  "subjectId": "test_subject",
  "date": "2026-04-01",
  "startTime": "10:00",
  "endTime": "12:00"
}
// Expected: 201, schedule created

// Test 2: Create small group
POST /api/schedules
{
  "students": ["s1", "s2"],
  "tutorId": "test_tutor",
  "subjectId": "test_subject",
  "date": "2026-04-02",
  "startTime": "14:00",
  "endTime": "16:00",
  "sessionType": "small-group"
}
// Expected: 201, schedule created

// Test 3: Enroll student in group
POST /api/schedules/{groupSessionId}/enroll-student
{
  "studentId": "s3"
}
// Expected: 200, student enrolled

// Test 4: Verify capacity limit
POST /api/schedules/{groupSessionId}/enroll-student
{
  "studentId": "s4"
}
// Expected: 400, at capacity (small-group max 3)
```

## Post-Deployment Verification

### Check Application Logs
```bash
# Look for errors related to scheduling
tail -f logs/app.log | grep -i schedule

# Should see:
# ✓ No deprecation warnings
# ✓ No connection errors
# ✓ No validation failures
```

### Verify Database
```javascript
// Check that one-on-one sessions have defaults
db.schedules.find({ sessionType: { $exists: false } }).count()
// Expected: 0 (all should have sessionType set to 'one-on-one')

// Check index creation
db.schedules.getIndexes()
// Should see new index on students array
```

### Test All Scenarios

#### Scenario 1: Backward Compatibility
```javascript
// Existing workflow should work unchanged
// Try creating session with old API format (no sessionType)
// Should default to one-on-one
```

#### Scenario 2: New Functionality
```javascript
// Create group sessions
// Enroll students
// Remove students
// Verify capacity enforcement
```

#### Scenario 3: Conflict Detection
```javascript
// Room conflicts
// Tutor conflicts
// Student conflicts (NEW)
// All should be prevented
```

#### Scenario 4: Validation
```javascript
// Test all 8 error scenarios from guide
// Verify correct error messages
// Verify HTTP status codes correct
```

### Monitoring Dashboard
- [ ] Check error rate (should be ~0% for valid operations)
- [ ] Monitor response times (should be <200ms)
- [ ] Review audit logs (should show new operations)
- [ ] Check database size (small increase for new fields)

## Rollback Plan

If critical issues found:

### Option 1: Code Rollback
```bash
# Revert to previous version
git revert HEAD

# Restart services
pm2 restart all
```

### Option 2: Database Rollback
```bash
# Restore from backup
mongorestore --db beebright /backup/{timestamp}

# Restart services
pm2 restart all
```

### Communication
- Notify stakeholders of issue
- Post status on internal channel
- Provide ETA for resolution

## Performance Baseline

**Before Deployment**: Record these metrics
```
- Average schedule creation time: ___ ms
- Database query times for conflicts: ___ ms
- Server response time (p95): ___ ms
- Error rate: ___ %
```

**After Deployment**: Compare
```
- Average schedule creation time: ___ ms (should be similar ±10%)
- Database query times for conflicts: ___ ms (should be similar ±10%)
- Server response time (p95): ___ ms (should be similar ±10%)
- Error rate: ___ % (should be <1% for valid operations)
```

## Training Materials Needed

### For Admins
- [ ] Quick reference guide updated (provided)
- [ ] Tutorial videos recorded
- [ ] Step-by-step UI screenshots
- [ ] Common errors guide

### For Developers
- [ ] Implementation details documented (provided)
- [ ] Code walkthrough video
- [ ] Testing procedures documented (provided)
- [ ] API documentation updated

### For Users (Tutors & Students)
- [ ] Updated FAQ
- [ ] User guide for new features
- [ ] Video tutorials

## Support Escalation

**Level 1: Admin Support**
- Can create/manage sessions
- Can enroll/remove students
- Can handle common errors

**Level 2: Technical Support**
- Can access logs
- Can run diagnostics
- Can fix data issues

**Level 3: Development Team**
- Can modify code
- Can handle database issues
- Can implement hot fixes

## Success Criteria

Deployment is successful if:

1. ✓ All existing one-on-one schedules work unchanged
2. ✓ Can create small-group sessions (max 3)
3. ✓ Can create playgroup sessions (max 10)
4. ✓ Can enroll students in group sessions
5. ✓ Can remove students from group sessions
6. ✓ Room conflicts prevented for all types
7. ✓ Tutor conflicts prevented for all types
8. ✓ Student conflicts prevented
9. ✓ Capacity enforcement working
10. ✓ Validation messages clear and helpful
11. ✓ No data corruption observed
12. ✓ Performance acceptable (<5% degradation)
13. ✓ Audit logs recording all operations
14. ✓ Error rates <1% for valid operations

## Post-Deployment Activities

### Day 1 (Deployment Day)
- [ ] Continuous monitoring
- [ ] Quick response to issues
- [ ] Validate all smoke tests pass
- [ ] Check error logs hourly

### Days 2-7 (Stabilization)
- [ ] Daily monitoring
- [ ] Review usage patterns
- [ ] Collect initial feedback
- [ ] Document any issues

### Week 2+ (Optimization)
- [ ] Analyze performance data
- [ ] Optimize queries if needed
- [ ] Update documentation based on feedback
- [ ] Plan future enhancements

## Documentation Checklist

- [x] SCHEDULING_UPGRADE_GUIDE.md - Complete user guide
- [x] SCHEDULING_IMPLEMENTATION_DETAILS.md - Developer reference
- [x] SCHEDULING_QUICK_REFERENCE.md - Admin quick guide
- [x] This deployment checklist
- [ ] API documentation (update swagger/openapi)
- [ ] README updates
- [ ] Training videos
- [ ] FAQ document

## Contacts & Escalation

| Issue Type | Contact | Response Time |
|-----------|---------|----------------|
| General Questions | Admin Support Team | 2 hours |
| Technical Issues | Dev Team | 1 hour |
| Database Issues | DBA | Immediate |
| Critical Bugs | CTO | Immediate |

## Sign-Off

- [ ] Code review complete
- [ ] Tests passing
- [ ] Documentation complete
- [ ] Backup verified
- [ ] Team trained
- [ ] Ready for deployment

**Deployment Date**: [Date]  
**Deployed By**: [Name]  
**Approved By**: [Manager Name]  

---

## Appendix: Rollback Timeline

If rollback needed:

```
T+0 min: Issue detected
T+5 min: Issue confirmed
T+10 min: Decision made to rollback
T+15 min: Backup verified
T+20 min: Rollback initiated
T+30 min: Services restarted
T+40 min: Smoke tests run
T+45 min: Stakeholders notified
T+60 min: Post-mortem planning
```

---

**Deployment Version**: 1.0  
**Release Date**: March 29, 2026  
**Status**: Ready for Deployment
