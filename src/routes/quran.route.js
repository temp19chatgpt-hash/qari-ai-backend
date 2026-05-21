const express = require('express');
const axios = require('axios');
const { content_config } = require('../config/env');
const { getAccessToken } = require('../services/auth.service');

const router = express.Router();

// Global proxy route for any QF API endpoint
router.use('/', async (req, res) => {
  try {
    const token = await getAccessToken();
    
    // req.url contains the path after /api/quran
    const targetUrl = `${content_config.base_url}${req.url}`;
    
    console.log(`[PROXY] ${req.method} ${targetUrl}`);

    const response = await axios({
      method: req.method,
      url: targetUrl,
      headers: {
        'x-auth-token': token,
        'x-client-id': content_config.client_id,
      },
      data: req.method !== 'GET' ? req.body : undefined,
      params: req.method === 'GET' ? req.query : undefined
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error("Error calling QF API:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json(error.response?.data || { error: 'Failed' });
  }
});

module.exports = router;
