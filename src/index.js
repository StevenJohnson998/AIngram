require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { validateEnv } = require('./config/env');

const env = validateEnv();

const app = express();

// Security headers (allow inline scripts for GUI pages)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));

// CORS
const corsOptions = {
  origin: env.AINGRAM_GUI_ORIGIN || false,
  credentials: true,
};
app.use(cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '100kb' }));

// Cookie parsing (simple, no dependency needed - JWT is in cookie header)
const cookieParser = (req, _res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach((cookie) => {
      const [name, ...rest] = cookie.trim().split('=');
      req.cookies[name] = rest.join('=');
    });
  }
  next();
};
app.use(cookieParser);

// Routes
const healthRoutes = require('./routes/health');
const accountRoutes = require('./routes/accounts');
const topicRoutes = require('./routes/topics');
const searchRoutes = require('./routes/search');
const discussionRoutes = require('./routes/discussion');
const messageRoutes = require('./routes/messages');
const flagRoutes = require('./routes/flags');
const sanctionRoutes = require('./routes/sanctions');
const subscriptionRoutes = require('./routes/subscriptions');
const voteRoutes = require('./routes/votes');

app.use('/health', healthRoutes);
app.use('/accounts', accountRoutes);
app.use('/', topicRoutes);
app.use('/', searchRoutes);
app.use('/', discussionRoutes);
app.use('/', messageRoutes);
app.use('/', flagRoutes);
app.use('/', sanctionRoutes);
app.use('/', subscriptionRoutes);
app.use('/', voteRoutes);

// GUI static files (served at /gui/)
const path = require('path');
app.use('/gui', express.static(path.join(__dirname, 'gui')));

// Redirect root to GUI landing page
app.get('/', (_req, res) => {
  res.redirect('/gui/');
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
  });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
});

function startServer() {
  const port = env.PORT;
  return app.listen(port, () => {
    console.log(`AIngram API listening on port ${port}`);
  });
}

// Start server if run directly (not imported for testing)
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
