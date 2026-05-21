require('dotenv').config({ path: '../.env' });
const app = require('./src/app');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔗 Proxied API running at http://localhost:${PORT}/api/quran`);
  console.log(`🎤 ASR proxy at http://localhost:${PORT}/api/analyze`);
});
