const User = require('../models/User');
const Subject = require('../models/Subject');
const Payment = require('../models/Payment');
const Enrollment = require('../models/Enrollment');

const getSettledValue = (result, fallback = 0) =>
  result.status === 'fulfilled' && typeof result.value === 'number' ? result.value : fallback;

// @desc    Get dashboard summary stats (admin only)
// @route   GET /api/dashboard/stats
// @access  Private (Admin)
const getDashboardStats = async (req, res) => {
  try {
    const [totalStudentsResult, activeTutorsResult, pendingEnrollmentsResult, revenueResult] = await Promise.allSettled([
      // "Enrolled Students" = enrollments that have been approved
      // Children are not separate login accounts — the count comes from Enrollment, not User
      Enrollment.countDocuments({ status: { $in: ['approved', 'active'] } }),
      User.countDocuments({ role: 'tutor', isActive: true, isArchived: { $ne: true }, deletedAt: null }),
      Enrollment.countDocuments({ status: { $in: ['submitted', 'payment_under_verification', 'pending_approval', 'pending'] } }),
      getMonthlyRevenue()
    ]);

    res.status(200).json({
      success: true,
      stats: {
        totalStudents: getSettledValue(totalStudentsResult),
        activeTutors: getSettledValue(activeTutorsResult),
        pendingEnrollments: getSettledValue(pendingEnrollmentsResult),
        monthlyRevenue: getSettledValue(revenueResult)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch dashboard stats'
    });
  }
};

// @desc    Get public landing stats
// @route   GET /api/dashboard/public-stats
// @access  Public
const getPublicLandingStats = async (req, res) => {
  try {
    const monthlyNewStudents = await getMonthlyNewStudentsCount();

    res.status(200).json({
      success: true,
      stats: {
        monthlyNewStudents
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch public dashboard stats'
    });
  }
};

// Sum of verified payments for the current month
async function getMonthlyRevenue() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const result = await Payment.aggregate([
    { $match: { status: 'verified' } },
    {
      $addFields: {
        dateToUse: { $ifNull: ['$verifiedAt', '$createdAt'] }
      }
    },
    {
      $match: {
        dateToUse: { $gte: startOfMonth, $lte: endOfMonth }
      }
    },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  return result.length > 0 ? result[0].total : 0;
}

async function getMonthlyNewStudentsCount() {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return User.countDocuments({
    role: 'student',
    createdAt: { $gte: startOfMonth, $lt: endOfMonth }
  });
}

module.exports = {
  getDashboardStats,
  getPublicLandingStats
};
