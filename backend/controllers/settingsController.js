const SystemSettings = require('../models/SystemSettings');
const Announcement = require('../models/Announcement');

function startOfTodayLocal() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function endOfTodayLocal() {
  const today = startOfTodayLocal();
  today.setHours(23, 59, 59, 999);
  return today;
}

async function getScheduledMaintenanceEnabled() {
  const activeAnnouncement = await Announcement.exists({
    authorRole: 'admin',
    category: 'maintenance',
    status: 'approved',
    scheduledDate: {
      $gte: startOfTodayLocal(),
      $lte: endOfTodayLocal(),
    },
  });

  return !!activeAnnouncement;
}

async function getMaintenanceState() {
  const doc = await SystemSettings.findOne({}).lean();
  const manualMaintenanceMode = doc ? !!doc.maintenanceMode : false;
  const scheduledMaintenanceMode = await getScheduledMaintenanceEnabled();

  return {
    manualMaintenanceMode,
    scheduledMaintenanceMode,
    maintenanceMode: manualMaintenanceMode || scheduledMaintenanceMode,
  };
}

async function getMaintenanceEnabled() {
  const state = await getMaintenanceState();
  return state.maintenanceMode;
}

async function setMaintenanceEnabled(enabled) {
  await SystemSettings.findOneAndUpdate(
    {},
    { maintenanceMode: !!enabled },
    { upsert: true, new: true }
  );
}

// @desc    Get maintenance mode (public, for login page check)
// @route   GET /api/settings/maintenance
exports.getMaintenance = async (req, res) => {
  try {
    const state = await getMaintenanceState();
    return res.json({ success: true, ...state });
  } catch (err) {
    console.error('getMaintenance error:', err);
    return res.status(500).json({ success: false, message: 'Failed to get settings' });
  }
};

// @desc    Set maintenance mode (admin only)
// @route   PUT /api/settings/maintenance
exports.setMaintenance = async (req, res) => {
  try {
    const enabled = req.body.enabled === true || req.body.maintenanceMode === true;
    await setMaintenanceEnabled(enabled);
    return res.json({ success: true, maintenanceMode: enabled });
  } catch (err) {
    console.error('setMaintenance error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update settings' });
  }
};

exports.getMaintenanceEnabled = getMaintenanceEnabled;
exports.setMaintenanceEnabled = setMaintenanceEnabled;
exports.getMaintenanceState = getMaintenanceState;
