const path = require('path');
// Load .env from parent (local dev) or current (monorepo deployments) dir
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
require('dotenv').config(); 

// Hybrid Credential Logic
const QF_AUTH_CLIENT_ID = process.env.QF_AUTH_CLIENT_ID;
const QF_AUTH_CLIENT_SECRET = process.env.QF_AUTH_CLIENT_SECRET;
const QF_AUTH_BASE_URL = process.env.QF_AUTH_BASE_URL;

const QF_CONTENT_CLIENT_ID = process.env.QF_CONTENT_CLIENT_ID;
const QF_CONTENT_CLIENT_SECRET = process.env.QF_CONTENT_CLIENT_SECRET;
const QF_CONTENT_BASE_URL = process.env.QF_CONTENT_BASE_URL;
const QF_CONTENT_AUTH_URL = process.env.QF_CONTENT_AUTH_URL;

const ASR_SERVICE_URL = process.env.ASR_URL || 'http://127.0.0.1:5001';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Final Resolved Configs
const auth_config = {
  client_id: QF_AUTH_CLIENT_ID,
  client_secret: QF_AUTH_CLIENT_SECRET,
  base_url: QF_AUTH_BASE_URL
};

const content_config = {
  client_id: QF_CONTENT_CLIENT_ID,
  client_secret: QF_CONTENT_CLIENT_SECRET,
  base_url: QF_CONTENT_BASE_URL,
  auth_url: QF_CONTENT_AUTH_URL
};

if (!QF_AUTH_CLIENT_ID || !QF_CONTENT_CLIENT_ID) {
  console.error("Missing Hybrid Quran Foundation API credentials.");
  process.exit(1);
}

module.exports = {
  auth_config,
  content_config,
  ASR_SERVICE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY
};
