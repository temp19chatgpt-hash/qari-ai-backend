const express = require('express');
const cors = require('cors');

const { identifyUser } = require('./middleware/identify');
const authRoutes = require('./routes/auth.route');
const quranRoutes = require('./routes/quran.route');
const analysisRoutes = require('./routes/analysis.route');
const dashboardRoutes = require('./routes/dashboard.route');

const app = express();

app.use(cors());
app.use(express.json());

// Identify user from JWT on every request
app.use(identifyUser);

// Mount the routes
app.use('/api/auth', authRoutes);
app.use('/api/quran', quranRoutes);
app.use('/api', analysisRoutes); // /analyze, /analyze-reference, /analyze-word-hybrid
app.use('/api/dashboard', dashboardRoutes); // /stats, /tajweed

// Root Health Check
app.get('/', (req, res) => {
  res.json({
    status: "online",
    service: "Qari AI Backend",
    message: "Backend is operational. API routes are under /api"
  });
});

module.exports = app;
