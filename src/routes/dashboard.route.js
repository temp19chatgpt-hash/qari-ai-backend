const express = require('express');
const { getDashboardStats, getTajweedMastery, getSessionAudioUrl } = require('../services/db.service');

const router = express.Router();

// GET /api/dashboard/stats — streak, sessions, ayahs, score, recent
router.get('/stats', async (req, res) => {
  if (req.userId === 'guest') {
    return res.json({ source: 'guest', message: 'Use localStorage for guest stats' });
  }

  try {
    const { filter } = req.query;
    const stats = await getDashboardStats(req.userId, filter, req.token);
    if (!stats) return res.json({ source: 'guest', message: 'DB unavailable' });

    res.json({ source: 'db', ...stats });
  } catch (err) {
    console.error('[Dashboard] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/dashboard/audio/:id — fetch specifically on-demand
router.get('/audio/:id', async (req, res) => {
  try {
    const url = await getSessionAudioUrl(req.params.id);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audio' });
  }
});

// GET /api/dashboard/tajweed — per-rule mastery averages
router.get('/tajweed', async (req, res) => {
  if (req.userId === 'guest') {
    return res.json({ source: 'guest', mastery: {} });
  }

  try {
    const mastery = await getTajweedMastery(req.userId);
    res.json({ source: 'db', mastery: mastery || {} });
  } catch (err) {
    console.error('[Dashboard] Tajweed error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tajweed mastery' });
  }
});

module.exports = router;
