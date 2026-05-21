const express = require('express');
const axios = require('axios');
const { auth_config } = require('../config/env');

const router = express.Router();

// OAuth2 Login URL Generator
router.get('/login-url', (req, res) => {
  const redirect_uri = req.query.redirect_uri || 'http://localhost:3000/callback';
  const state = Math.random().toString(36).substring(2, 15);
  const nonce = Math.random().toString(36).substring(2, 15);
  
  // Using the discovered endpoint /oauth2/auth
  // For Identity, we use the Prelive keys (auth_config) which support openid
  const url = `${auth_config.base_url}/oauth2/auth?client_id=${auth_config.client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&scope=openid%20offline_access%20user%20streak&state=${state}&nonce=${nonce}`;
  
  console.log(`[OAUTH] Generated Login URL: ${url}`);
  res.json({ url });
});

// OAuth2 User Login Callback handler
router.post('/callback', async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code) return res.status(400).json({ error: "Authorization code required" });

  console.log(`[OAUTH] Exchanging code: ${code.substring(0, 5)}... for redirect_uri: ${redirect_uri}`);

  try {
    const response = await axios.post(
      `${auth_config.base_url}/oauth2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirect_uri
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: {
          username: auth_config.client_id,
          password: auth_config.client_secret
        }
      }
    );
    console.log(`[OAUTH] Token exchange successful!`);
    res.json(response.data);
  } catch (error) {
    console.error("[OAUTH] Callback error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to exchange authorization code", details: error.response?.data });
  }
});

// Refresh OAuth Token
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: "Refresh token required" });

  try {
    const response = await axios.post(
      `${auth_config.base_url}/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        auth: {
          username: auth_config.client_id,
          password: auth_config.client_secret
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error("[OAUTH] Refresh error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: "Failed to refresh token", details: error.response?.data });
  }
});

// Upsert user in DB after login
router.post('/upsert-user', async (req, res) => {
  const { qf_user_id, name, email } = req.body;
  if (!qf_user_id) return res.status(400).json({ error: "Missing qf_user_id" });

  try {
    const { upsertUser } = require('../services/db.service');
    const user = await upsertUser(qf_user_id, name, email);
    res.json({ success: true, user });
  } catch (err) {
    console.error('[Auth] Upsert user error:', err.message);
    res.status(500).json({ error: 'Failed to upsert user' });
  }
});

module.exports = router;
