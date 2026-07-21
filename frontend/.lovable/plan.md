
# Add Edit Profile Feature for All Users

## Overview
Add an "Edit Profile" page accessible from all user dashboards (Student, Tutor, Admin) where users can update their name, password, and role-specific profile information.

---

## Profile Fields

### Core Fields (All Users)
- **Name** - Display name (editable)
- **Email** - View only
- **Password** - Change password with confirmation field
- **Profile Photo** - Avatar display (UI ready, mock functionality)
- **Phone Number** - Contact number

### Role-Specific Fields

**Students:**
- Grade Level (e.g., Grade 9, Grade 10, Grade 11, Grade 12)
- Parent/Guardian Contact
- Emergency Contact

**Tutors:**
- Subjects Taught (multi-select or tags)

**Admins:**
- Role Level (Admin, Super Admin dropdown)

---

## Implementation Steps

### 1. Update AuthContext
Add an `updateUser` function to allow profile updates and persist to localStorage.

### 2. Add Settings Navigation to All Roles
Update `DashboardLayout.tsx` to include a "Settings" link for all user roles.

### 3. Create Shared Profile Page
Create `src/pages/ProfileSettings.tsx` that:
- Uses `DashboardLayout` wrapper
- Shows editable form fields based on user role
- Includes password change section
- Has save/cancel buttons with toast notifications

### 4. Add Routes
Add protected routes for each role's profile page.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/contexts/AuthContext.tsx` | Modify | Add `updateUser` function and extended user fields |
| `src/components/layout/DashboardLayout.tsx` | Modify | Add "Settings" to all role navigations |
| `src/pages/ProfileSettings.tsx` | Create | Shared profile edit page |
| `src/App.tsx` | Modify | Add profile routes for all roles |

---

## Technical Details

### Extended User Interface
```text
interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  phone?: string;
  // Student fields
  gradeLevel?: string;
  parentContact?: string;
  emergencyContact?: string;
  // Tutor fields
  subjectsTaught?: string[];
  // Admin fields
  adminLevel?: "admin" | "super_admin";
}
```

### Navigation Addition (All Roles)
Each role gets a Settings link at the bottom of their navigation menu.

### Profile Page Sections
1. **Personal Information Card** - Name, Email (read-only), Phone
2. **Password & Security Card** - Current password, New password, Confirm password
3. **Role-Specific Card** - Dynamic fields based on user role

### Form Validation
- Password: min 8 characters, must match confirmation
- Required fields validation
- Success/error toast notifications
