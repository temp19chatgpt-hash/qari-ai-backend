const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const { ASR_SERVICE_URL } = require('../config/env');
const { savePracticeSession, saveWordLabAttempt, upsertUser } = require('../services/db.service');

const router = express.Router();

// Multer for audio file uploads (store in memory)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

router.post('/analyze', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file provided" });

  const expectedText = req.body.expected_text;
  if (!expectedText) return res.status(400).json({ error: "No expected_text provided" });

  console.log(`[ASR] Analyzing audio (${(req.file.size / 1024).toFixed(1)} KB) against: "${expectedText.substring(0, 40)}..."`);

  try {
    const formData = new FormData();
    formData.append('audio', req.file.buffer, {
      filename: 'recording.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    formData.append('expected_text', expectedText);

    // Forward precomputed data from frontend
    if (req.body.normalized_expected) formData.append('normalized_expected', req.body.normalized_expected);
    if (req.body.word_list) formData.append('word_list', req.body.word_list);
    if (req.body.tajweed_map) formData.append('tajweed_map', req.body.tajweed_map);
    if (req.body.word_durations) formData.append('word_durations', req.body.word_durations);
    if (req.body.reference_duration) formData.append('reference_duration', req.body.reference_duration);
    if (req.body.reference_audio_url) formData.append('reference_audio_url', req.body.reference_audio_url);

    const response = await axios.post(`${ASR_SERVICE_URL}/analyze`, formData, {
      headers: formData.getHeaders(),
      timeout: 120000, // 120s timeout for Whisper processing
    });

    console.log(`[ASR] Result: score=${response.data.score}/100 (${response.data.grade}) accuracy=${response.data.accuracy}%`);
    if (!response.data.raw_text) console.warn("[ASR] ⚠️ Warning: raw_text is MISSING or EMPTY in ASR response!");
    else console.log(`[ASR] Raw Text Received: "${response.data.raw_text}"`);

    res.json(response.data);

    // 🔥 Fire-and-forget: save to DB (doesn't block response)
    if (req.userId && req.userId !== 'guest') {
      upsertUser(req.userId, req.userName, req.userEmail)
        .then(() => {
          return savePracticeSession(req.userId, response.data, {
            surah: parseInt(req.body.chapter_id) || 0,
            ayah: parseInt(req.body.verse_id) || 0
          }, req.file.buffer);
        })
        .catch(err => console.error('[DB] Async save failed:', err.message));
    }
  } catch (error) {
    console.error("[ASR] Error:", error.response?.data || error.message);
    if (error.code === 'ECONNREFUSED') {
      res.status(503).json({ error: "ASR service not running. Start it with: python asr/asr_service.py" });
    } else {
      res.status(500).json({ error: "Analysis failed", details: error.response?.data || error.message });
    }
  }
});

// Proxy to ASR Service (Word Trainer 3.0 Pre-Analysis)
router.post('/analyze-reference', async (req, res) => {
  try {
    const response = await axios.post(`${ASR_SERVICE_URL}/api/analyze-reference`, req.body, { timeout: 30000 });
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    if (status === 504 || error.code === 'ECONNABORTED') {
      console.warn(`[ASR Proxy] 🌙 Python service is likely waking from sleep (Timeout/504).`);
    } else if (error.code === 'ECONNREFUSED') {
      console.warn(`[ASR Proxy] 🛑 Python service is currently offline.`);
    } else {
      console.error('❌ Reference analysis proxy error:', error.message);
    }
    res.status(status).json(error.response?.data || { error: 'ASR Service connection failed' });
  }
});

// Proxy to ASR Service (Acoustic Pre-warming)
router.post('/pre-warm', async (req, res) => {
  try {
    const response = await axios.post(`${ASR_SERVICE_URL}/pre-warm`, req.body, { timeout: 30000 });
    res.json(response.data);
  } catch (error) {
    const status = error.response?.status || 500;
    console.error('❌ Pre-warm proxy error:', error.message);
    res.status(status).json(error.response?.data || { error: 'ASR Service connection failed' });
  }
});

// Proxy to ASR Service (Word Trainer Hybrid Analysis)
router.post('/analyze-word-hybrid', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No user audio provided" });

  try {
    const formData = new FormData();
    formData.append('audio', req.file.buffer, {
      filename: 'practice.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    
    // Pass along all form fields
    if (req.body.reference_audio_url) formData.append('reference_audio_url', req.body.reference_audio_url);
    if (req.body.reference_duration) formData.append('reference_duration', req.body.reference_duration);
    if (req.body.word_text) formData.append('word_text', req.body.word_text);
    if (req.body.tajweed_map) formData.append('tajweed_map', req.body.tajweed_map);

    const response = await axios.post(`${ASR_SERVICE_URL}/analyze-word-hybrid`, formData, {
      headers: formData.getHeaders(),
      timeout: 120000,
    });

    res.json(response.data);

    // 🔥 Fire-and-forget: save Word Lab attempt to DB
    if (req.userId && req.userId !== 'guest') {
      upsertUser(req.userId, req.userName, req.userEmail)
        .then(() => {
          return saveWordLabAttempt(req.userId, response.data, {
            word_text: req.body.word_text || '',
            surah: parseInt(req.body.surah_number) || 0,
            ayah: parseInt(req.body.ayah_number) || 0,
            position: parseInt(req.body.word_position) || 0,
            difficulty: req.body.difficulty || 'intermediate'
          });
        })
        .catch(err => console.error('[DB] Async word save failed:', err.message));
    }
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error("❌ [Word Hybrid] Timeout exceeded (120s)");
      res.status(504).json({ error: "Analysis timed out. Try again with a shorter recording." });
    } else if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
      console.error("❌ [Word Hybrid] ASR Service connection failed/reset");
      res.status(503).json({ error: "ASR Service unavailable. Check if Python is running." });
    } else {
      const errorData = error.response?.data || { error: error.message };
      console.error("[Word Hybrid] Error:", errorData);
      res.status(error.response?.status || 500).json({ 
        error: "Hybrid analysis failed", 
        details: errorData 
      });
    }
  }
});

module.exports = router;
