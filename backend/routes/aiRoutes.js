const express = require('express');
const router = express.Router();
const { getRecommendations, chat, publicChat, ollamaChat, getModelMetrics } = require('../controllers/aiController');
const { getAIDatasetStats } = require('../controllers/aiController');
const { protect, authorize, optionalProtect } = require('../middleware/auth');
const { publicAiChatLimiter, authenticatedAiChatLimiter } = require('../middleware/rateLimit');

router.get('/recommendations', protect, getRecommendations);
router.post('/chat', protect, authenticatedAiChatLimiter, chat);
router.post('/public-chat', publicAiChatLimiter, publicChat);
router.post('/ollama-chat', optionalProtect, authenticatedAiChatLimiter, ollamaChat);

// AI model metrics – restricted to admins / super admins
router.get('/metrics', protect, authorize('admin'), getModelMetrics);

// AI dataset statistics – restricted to admins / super admins
router.get('/dataset-stats', protect, authorize('admin'), getAIDatasetStats);

module.exports = router;
