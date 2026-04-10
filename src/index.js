require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { validateEnv } = require('./config/env');

const env = validateEnv();

// QuarantineValidator boot warning -- visible in `docker logs` for instance operators.
// Not a fail-fast: dev/CI must be allowed to run without configuring an LLM provider.
// Banner GUI for runtime visibility is delivered separately (see task #7).
if (!process.env.QUARANTINE_VALIDATOR_API_KEY) {
  console.warn('');
  console.warn('=================================================================');
  console.warn('  WARNING: QuarantineValidator NOT CONFIGURED');
  console.warn('  User-generated content will NOT be sandboxed for prompt injection.');
  console.warn('  This is INSECURE for production use.');
  console.warn('  Set QUARANTINE_VALIDATOR_API_KEY in .env -- see .env.example.');
  console.warn('=================================================================');
  console.warn('');
}

const app = express();

// Trust first proxy (Caddy) for correct client IP in rate limiting
app.set('trust proxy', 1);

// Security headers -- strict CSP (S6 hardening, 2026-04-10).
// All inline scripts/styles have been migrated to external files in src/gui/js/
// and src/gui/css/. CSP no longer allows ANY 'unsafe-inline'. Pattern matches
// what Mastodon, Ghost, Plausible, Umami do for self-hosted profiles: no nonces,
// no hashes, just 'self' + external files. Maintenance: zero (any new inline
// added by mistake will be blocked by the browser and visible in dev console).
//
// upgrade-insecure-requests disabled: Caddy handles HTTPS termination,
// the app only sees HTTP internally. The directive would break internal requests.
// CSP: allow analytics domain if configured
const analyticsOrigin = process.env.ANALYTICS_SCRIPT_URL
  ? new URL(process.env.ANALYTICS_SCRIPT_URL).origin
  : null;
const cspScriptSrc = ["'self'"];
const cspConnectSrc = ["'self'"];
if (analyticsOrigin) {
  cspScriptSrc.push(analyticsOrigin);
  cspConnectSrc.push(analyticsOrigin);
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: cspScriptSrc,
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: cspConnectSrc,
      upgradeInsecureRequests: null,
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

// Response envelope middleware: ensures all JSON responses follow {data: ...} or {error: ...} pattern.
// List responses already return {data: [], pagination: {}} -- those pass through unchanged.
// Single-object responses (topic, chunk, account) get wrapped in {data: ...}.
app.use((_req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    if (body === null || body === undefined) return origJson(body);
    // Already enveloped: has data/error/status key at top level
    if (body.data !== undefined || body.error || body.status === 'ok') {
      return origJson(body);
    }
    return origJson({ data: body });
  };
  next();
});

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
const aiProviderRoutes = require('./routes/ai-providers');
const aiActionRoutes = require('./routes/ai-actions');
const activityRoutes = require('./routes/activity');
const reportRoutes = require('./routes/reports');
const disputeRoutes = require('./routes/dispute');
const copyrightReviewRoutes = require('./routes/copyright-review');
const suggestionRoutes = require('./routes/suggestions');
const metachunkRoutes = require('./routes/metachunks');
const summaryRoutes = require('./routes/summaries');
const debateRoutes = require('./routes/debates');
const analyticsRoutes = require('./routes/analytics');
const changesetRoutes = require('./routes/changesets');
const { mountMcp } = require('./mcp/server');

// API v1 routes (versioned prefix)
const v1 = express.Router();
v1.use('/health', healthRoutes);
v1.use('/accounts', accountRoutes);
v1.use('/', topicRoutes);
v1.use('/', searchRoutes);
v1.use('/', discussionRoutes);
v1.use('/', messageRoutes);
v1.use('/', flagRoutes);
v1.use('/', sanctionRoutes);
v1.use('/', subscriptionRoutes);
v1.use('/', voteRoutes);
v1.use('/ai/providers', aiProviderRoutes);
v1.use('/ai/actions', aiActionRoutes);
v1.use('/', activityRoutes);
v1.use('/', reportRoutes);
v1.use('/', disputeRoutes);
v1.use('/', copyrightReviewRoutes);
v1.use('/', suggestionRoutes);
v1.use('/', metachunkRoutes);
v1.use('/', summaryRoutes);
v1.use('/', debateRoutes);
v1.use('/', analyticsRoutes);
v1.use('/', changesetRoutes);

// Mount v1 at both /v1 and / (backwards compat during transition)
app.use('/v1', v1);
app.use('/', v1);

// MCP server (Streamable HTTP transport)
mountMcp(app);

// OpenAPI spec (explicit route for Caddy prefix path)
const path = require('path');
app.get('/aingram/openapi.json', (_req, res) => {
  res.sendFile(path.join(__dirname, 'gui', 'openapi.json'));
});

// Dynamic directives (Sprint 7b) — serve generated file
const { getDynamicDirectivePath } = require('./services/dynamic-directives');
app.get('/llms-copyright-dynamic.txt', (_req, res) => {
  const filePath = getDynamicDirectivePath();
  const fs = require('fs');
  if (fs.existsSync(filePath)) {
    res.type('text/plain').sendFile(filePath);
  } else {
    res.type('text/plain').sendFile(path.join(__dirname, 'gui', 'llms-copyright.txt'));
  }
});

// Branding + analytics config (configurable per deployment via env vars)
app.get('/brand.js', (_req, res) => {
  const brand = process.env.BRAND_NAME || 'AIngram';
  const brandHtml = process.env.BRAND_HTML || '<span>AI</span>ngram';
  const githubUrl = process.env.BRAND_GITHUB_URL || 'https://github.com/StevenJohnson998/AIngram';
  const analyticsUrl = process.env.ANALYTICS_SCRIPT_URL || '';
  const analyticsId = process.env.ANALYTICS_WEBSITE_ID || '';
  res.type('application/javascript').send(
    `var BRAND={name:${JSON.stringify(brand)},html:${JSON.stringify(brandHtml)},github:${JSON.stringify(githubUrl)}};` +
    `var ANALYTICS={scriptUrl:${JSON.stringify(analyticsUrl)},websiteId:${JSON.stringify(analyticsId)}};` +
    `document.addEventListener('DOMContentLoaded',function(){` +
    `document.querySelectorAll('.navbar-brand').forEach(function(el){el.innerHTML=BRAND.html;});` +
    `document.querySelectorAll('.footer-links a[href*="github.com/StevenJohnson998/AIngram"]').forEach(function(el){el.href=BRAND.github;el.textContent='GitHub';});` +
    `document.title=document.title.replace(/AIngram/g,BRAND.name);` +
    `if(ANALYTICS.scriptUrl&&ANALYTICS.websiteId){` +
    `var s=document.createElement('script');s.defer=true;s.src=ANALYTICS.scriptUrl;s.dataset.websiteId=ANALYTICS.websiteId;document.head.appendChild(s);` +
    `}` +
    `});`
  );
});

// GUI static files (served at root, after API routes)
app.use(express.static(path.join(__dirname, 'gui'), { extensions: ['html'] }));

// 404 handler
app.use((_req, res) => {
  // API requests get JSON, browser requests get the 404 page
  if (_req.accepts('html') && !_req.path.startsWith('/v1/') && !_req.path.startsWith('/accounts/') && !_req.path.startsWith('/mcp')) {
    return res.status(404).sendFile(path.join(__dirname, 'gui', '404.html'));
  }
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
  const server = startServer();

  // Background jobs moved to src/workers/index.js (separate Docker service)

  // Graceful shutdown: drain connections on SIGTERM/SIGINT
  const shutdown = (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    server.close(() => {
      console.log('HTTP server closed.');
      const { getPool } = require('./config/database');
      const pool = getPool();
      if (pool && typeof pool.end === 'function') {
        pool.end().then(() => {
          console.log('Database pool closed.');
          process.exit(0);
        }).catch(() => process.exit(1));
      } else {
        process.exit(0);
      }
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => {
      console.error('Forced shutdown after 10s timeout');
      process.exit(1);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, startServer };
