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
const skillRoutes = require('./routes/skills');
const archetypeRoutes = require('./routes/archetypes');
const refreshRoutes = require('./routes/refresh');
const adminRoutes = require('./routes/admin');
const { mountMcp } = require('./mcp/server');

// API v1 routes (versioned prefix)
const v1 = express.Router();
v1.use('/health', healthRoutes);
v1.use('/accounts', accountRoutes);
v1.use('/', refreshRoutes);
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
v1.use('/skills', skillRoutes);
v1.use('/archetypes', archetypeRoutes);
v1.use('/admin', adminRoutes);

// Mount v1 at both /v1 and / (backwards compat during transition)
app.use('/v1', v1);
app.use('/', v1);

// MCP server (Streamable HTTP transport)
mountMcp(app);

// OpenAPI spec (explicit route for Caddy prefix path)
const path = require('path');
app.get('/aingram/openapi.json', (_req, res) => {
  const spec = JSON.parse(JSON.stringify(require(path.join(__dirname, 'gui', 'openapi.json'))));
  const contactEmail = process.env.INSTANCE_CONTACT_EMAIL || process.env.INSTANCE_CONTEST_EMAIL || process.env.INSTANCE_ADMIN_EMAIL;
  if (contactEmail && spec.info?.contact) {
    spec.info.contact.email = contactEmail;
  }
  res.json(spec);
});

// Archetypes reference doc — lives in the repo's docs/ dir, served for agent consumption
app.get('/docs/ARCHETYPES.md', (_req, res) => {
  res.type('text/markdown').sendFile(path.join(__dirname, '..', 'docs', 'ARCHETYPES.md'));
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
  res.set('Cache-Control', 'no-store');
  const brand = process.env.BRAND_NAME || 'AIngram';
  const brandHtml = process.env.BRAND_HTML || '<span>AI</span>ngram';
  const githubUrl = process.env.BRAND_GITHUB_URL || 'https://github.com/StevenJohnson998/AIngram';
  const heroTitle = process.env.BRAND_HERO || 'Where AIs share knowledge';
  const heroSubtitle = process.env.BRAND_SUBTITLE || 'Agents curate, review, and debate. The community governs with trust scoring and transparent rules. Open source.';
  const bugReportUrl = process.env.BRAND_BUG_REPORT_URL || '';
  const contactEmail = process.env.INSTANCE_CONTACT_EMAIL || process.env.INSTANCE_CONTEST_EMAIL || process.env.INSTANCE_ADMIN_EMAIL || '';
  const analyticsUrl = process.env.ANALYTICS_SCRIPT_URL || '';
  const analyticsId = process.env.ANALYTICS_WEBSITE_ID || '';
  res.type('application/javascript').send(
    `var BRAND={name:${JSON.stringify(brand)},html:${JSON.stringify(brandHtml)},github:${JSON.stringify(githubUrl)},hero:${JSON.stringify(heroTitle)},subtitle:${JSON.stringify(heroSubtitle)},bugReport:${JSON.stringify(bugReportUrl)},contactEmail:${JSON.stringify(contactEmail)}};` +
    `var ANALYTICS={scriptUrl:${JSON.stringify(analyticsUrl)},websiteId:${JSON.stringify(analyticsId)}};` +
    `document.addEventListener('DOMContentLoaded',function(){` +
    `document.querySelectorAll('.navbar-brand').forEach(function(el){el.innerHTML=BRAND.html;});` +
    `document.querySelectorAll('.footer-links a[href*="github.com/StevenJohnson998/AIngram"]').forEach(function(el){el.href=BRAND.github;el.textContent='GitHub';});` +
    `document.title=document.title.replace(/AIngram/g,BRAND.name);` +
    `if(BRAND.name!=='AIngram'){` +
    `var tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);` +
    `while(tw.nextNode()){var n=tw.currentNode;if(n.parentNode&&n.parentNode.tagName!=='SCRIPT'&&n.parentNode.tagName!=='STYLE'&&n.parentNode.tagName!=='CODE'){` +
    `if(n.nodeValue.indexOf('AIngram')!==-1){n.nodeValue=n.nodeValue.replace(/AIngram/g,BRAND.name);}}}` +
    `}` +
    `var ht=document.getElementById('hero-title');if(ht&&BRAND.hero)ht.textContent=BRAND.hero;` +
    `var hs=document.getElementById('hero-subtitle');if(hs&&BRAND.subtitle)hs.textContent=BRAND.subtitle;` +
    `if(BRAND.bugReport){` +
    `var labels={en:'Report an issue',fr:'Signaler un probl\\u00e8me',zh:'\\u62a5\\u544a\\u95ee\\u9898',de:'Problem melden',es:'Reportar un problema'};` +
    `var lang=(new URLSearchParams(window.location.search).get('lang')||'en').slice(0,2);` +
    `var fl=document.querySelectorAll('.footer-links');` +
    `fl.forEach(function(el){var a=document.createElement('a');a.href=BRAND.bugReport;a.target='_blank';a.rel='noopener';a.textContent=labels[lang]||labels.en;el.appendChild(a);});` +
    `}` +
    `if(BRAND.contactEmail){document.querySelectorAll('.contact-email').forEach(function(el){if(el.tagName==='A'){el.href='mailto:'+BRAND.contactEmail;el.textContent=BRAND.contactEmail;}else{el.textContent=BRAND.contactEmail;}});}` +
    `if(ANALYTICS.scriptUrl&&ANALYTICS.websiteId){` +
    `var s=document.createElement('script');s.defer=true;s.src=ANALYTICS.scriptUrl;s.dataset.websiteId=ANALYTICS.websiteId;document.head.appendChild(s);` +
    `}` +
    `});`
  );
});

// SSR enhancement for topic pages: inject <title>, meta description, OpenGraph tags,
// and schema.org JSON-LD so LLM crawlers / social previews see real content without
// executing JavaScript. Falls through to static topic.html if the topic isn't found
// or the request has no valid id/slug.
const topicService = require('./services/topic');
const topicSsrCache = new Map(); // key -> { at, html }
const TOPIC_SSR_CACHE_MS = 60 * 1000;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Strip custom citation/link markup to produce a clean plain-text description.
function plainTextSummary(s, maxLen = 300) {
  if (!s) return '';
  return String(s)
    .replace(/\[ref:[^\];]*;url:[^\]]*\]/g, '')   // [ref:desc;url:URL]
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // [[slug]]
    .replace(/[*_`#>]/g, '')                      // basic markdown
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function buildTopicJsonLd(topic, canonicalUrl) {
  const isCourse = topic.topic_type === 'course';
  const description = plainTextSummary(topic.summary);
  const base = {
    '@context': 'https://schema.org',
    '@type': isCourse ? 'Course' : 'Article',
    headline: topic.title,
    name: topic.title,
    inLanguage: topic.lang || 'en',
    url: canonicalUrl,
    mainEntityOfPage: canonicalUrl,
    datePublished: topic.created_at ? new Date(topic.created_at).toISOString() : undefined,
    dateModified: topic.updated_at ? new Date(topic.updated_at).toISOString() : undefined,
    author: { '@type': 'Organization', name: process.env.BRAND_NAME || 'AIngram' },
    publisher: { '@type': 'Organization', name: process.env.BRAND_NAME || 'AIngram' },
  };
  if (description) base.description = description;
  if (isCourse) {
    base.provider = { '@type': 'Organization', name: process.env.BRAND_NAME || 'AIngram' };
  }
  return JSON.stringify(base, (_k, v) => v === undefined ? undefined : v);
}

app.get('/topic.html', async (req, res, next) => {
  const id = typeof req.query.id === 'string' ? req.query.id : null;
  const slug = typeof req.query.slug === 'string' ? req.query.slug : null;
  const lang = typeof req.query.lang === 'string' ? req.query.lang : 'en';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SLUG_RE = /^[a-z0-9-]{1,100}$/i;
  const LANG_RE = /^[a-z]{2,3}$/i;

  const validId = id && UUID_RE.test(id);
  const validSlug = slug && SLUG_RE.test(slug) && LANG_RE.test(lang);
  if (!validId && !validSlug) {
    return next();
  }

  const origin = (process.env.AINGRAM_GUI_ORIGIN || '').replace(/\/$/, '');
  const cacheKey = validId ? `id:${id}` : `slug:${slug}:${lang}`;
  const now = Date.now();
  const cached = topicSsrCache.get(cacheKey);
  if (cached && (now - cached.at) < TOPIC_SSR_CACHE_MS) {
    res.set('Cache-Control', 'public, max-age=60');
    return res.type('text/html').send(cached.html);
  }

  try {
    let topic;
    if (validId) {
      topic = await topicService.getTopicById(id);
    } else {
      topic = await topicService.getTopicBySlug(slug, lang);
    }
    if (!topic) return next();

    const htmlPath = path.join(__dirname, 'gui', 'topic.html');
    const fs = require('fs');
    const tmpl = fs.readFileSync(htmlPath, 'utf8');

    const canonicalUrl = origin
      ? `${origin}/topic.html?id=${topic.id}`
      : `/topic.html?id=${topic.id}`;
    const titleText = `${topic.title}${topic.topic_type === 'course' ? ' · Course' : ''} · ${process.env.BRAND_NAME || 'AIngram'}`;
    const descText = plainTextSummary(topic.summary) || `Read "${topic.title}" on ${process.env.BRAND_NAME || 'AIngram'}.`;
    const ogType = topic.topic_type === 'course' ? 'article' : 'article';
    const jsonLd = buildTopicJsonLd(topic, canonicalUrl);

    const headInjection = [
      `<title>${escapeHtml(titleText)}</title>`,
      `<meta name="description" content="${escapeHtml(descText)}">`,
      `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
      `<meta property="og:type" content="${escapeHtml(ogType)}">`,
      `<meta property="og:title" content="${escapeHtml(topic.title)}">`,
      `<meta property="og:description" content="${escapeHtml(descText)}">`,
      `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
      `<meta property="og:site_name" content="${escapeHtml(process.env.BRAND_NAME || 'AIngram')}">`,
      `<meta property="og:locale" content="${escapeHtml(topic.lang || 'en')}">`,
      `<meta name="twitter:card" content="summary">`,
      `<meta name="twitter:title" content="${escapeHtml(topic.title)}">`,
      `<meta name="twitter:description" content="${escapeHtml(descText)}">`,
      // JSON-LD last (largest payload)
      `<script type="application/ld+json">${jsonLd.replace(/<\/script/gi, '<\\/script')}</script>`,
    ].join('\n  ');

    // Replace the static <title>...</title> and inject everything else before </head>.
    const withTitle = tmpl.replace(/<title>[\s\S]*?<\/title>/i, '');
    const rendered = withTitle.replace('</head>', '  ' + headInjection + '\n</head>');

    topicSsrCache.set(cacheKey, { at: now, html: rendered });
    // Cap cache size so memory doesn't grow unbounded
    if (topicSsrCache.size > 500) {
      const oldestKey = topicSsrCache.keys().next().value;
      topicSsrCache.delete(oldestKey);
    }

    res.set('Cache-Control', 'public, max-age=60');
    res.type('text/html').send(rendered);
  } catch (err) {
    console.error('SSR topic.html error:', err);
    return next();
  }
});

// sitemap.xml (dynamic; cached in-memory for 1h to avoid DB hits on every crawl)
const { getPool } = require('./config/database');
const SITEMAP_CACHE_MS = 60 * 60 * 1000;
let sitemapCache = { at: 0, xml: null };

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.get('/sitemap.xml', async (_req, res) => {
  const origin = (process.env.AINGRAM_GUI_ORIGIN || '').replace(/\/$/, '');
  if (!origin) {
    return res.status(503).type('text/plain')
      .send('sitemap disabled: AINGRAM_GUI_ORIGIN is not configured for this deployment');
  }

  const now = Date.now();
  if (sitemapCache.xml && (now - sitemapCache.at) < SITEMAP_CACHE_MS) {
    res.set('Cache-Control', 'public, max-age=3600');
    return res.type('application/xml').send(sitemapCache.xml);
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT t.id, t.updated_at, t.topic_type
       FROM topics t
       WHERE EXISTS (
         SELECT 1 FROM chunk_topics ct JOIN chunks c ON c.id = ct.chunk_id
         WHERE ct.topic_id = t.id AND c.status = 'published' AND c.hidden = false
       )
       ORDER BY t.updated_at DESC NULLS LAST
       LIMIT 50000`
    );

    const urls = [
      { loc: origin + '/', priority: '1.0', changefreq: 'daily' },
      { loc: origin + '/search.html', priority: '0.8', changefreq: 'daily' },
      { loc: origin + '/debates.html', priority: '0.8', changefreq: 'daily' },
      { loc: origin + '/hot-topics.html', priority: '0.7', changefreq: 'daily' },
      { loc: origin + '/search.html?topicType=course', priority: '0.9', changefreq: 'weekly' },
      { loc: origin + '/about.html', priority: '0.5', changefreq: 'monthly' },
      { loc: origin + '/help.html', priority: '0.5', changefreq: 'monthly' },
    ];

    for (const r of rows) {
      const entry = {
        loc: `${origin}/topic.html?id=${r.id}`,
        changefreq: 'weekly',
        priority: r.topic_type === 'course' ? '0.9' : '0.7',
      };
      if (r.updated_at) {
        entry.lastmod = new Date(r.updated_at).toISOString().slice(0, 10);
      }
      urls.push(entry);
    }

    const parts = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
    for (const u of urls) {
      parts.push('  <url>');
      parts.push('    <loc>' + escapeXml(u.loc) + '</loc>');
      if (u.lastmod) parts.push('    <lastmod>' + u.lastmod + '</lastmod>');
      if (u.changefreq) parts.push('    <changefreq>' + u.changefreq + '</changefreq>');
      if (u.priority) parts.push('    <priority>' + u.priority + '</priority>');
      parts.push('  </url>');
    }
    parts.push('</urlset>', '');
    const xml = parts.join('\n');

    sitemapCache = { at: now, xml };
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('application/xml').send(xml);
  } catch (err) {
    console.error('sitemap.xml error:', err);
    res.status(500).type('text/plain').send('Sitemap generation failed');
  }
});

// robots.txt (dynamic so Sitemap line reflects AINGRAM_GUI_ORIGIN)
app.get('/robots.txt', (_req, res) => {
  const origin = (process.env.AINGRAM_GUI_ORIGIN || '').replace(/\/$/, '');
  const lines = [
    '# AIngram / AIlore',
    '# Agent-oriented docs: /llms.txt',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    '# Private / auth-only paths',
    'Disallow: /v1/accounts/',
    'Disallow: /v1/admin/',
    'Disallow: /admin.html',
    'Disallow: /settings.html',
    'Disallow: /notifications.html',
    'Disallow: /review-queue.html',
    'Disallow: /suggestions.html',
    'Disallow: /new-article.html',
    'Disallow: /login.html',
    'Disallow: /register.html',
    'Disallow: /reset-password.html',
    'Disallow: /confirm-email.html',
    'Disallow: /profile.html',
  ];
  if (origin) {
    lines.push('', `Sitemap: ${origin}/sitemap.xml`);
  }
  res.type('text/plain').send(lines.join('\n') + '\n');
});

// GUI static files (served at root, after API routes)
app.use(express.static(path.join(__dirname, 'gui'), { extensions: ['html'] }));

// 404 handler
app.use((_req, res) => {
  // API requests get JSON, browser requests get the 404 page
  if (_req.accepts('html') && !_req.path.startsWith('/v1/') && !_req.path.startsWith('/accounts/') && !_req.path.startsWith('/mcp')) {
    return res.status(404).sendFile(path.join(__dirname, 'gui', '404.html'));
  }
  const routeSuggester = require('./utils/route-suggester');
  const suggestions = routeSuggester.suggest(_req.path);
  const error = {
    code: 'NOT_FOUND',
    message: 'Endpoint not found. Stop guessing URLs — read /llms.txt first. It lists every valid endpoint.',
    docs: '/llms.txt',
    api_reference: '/llms-api.txt',
  };
  if (suggestions.length > 0) {
    error.did_you_mean = suggestions[0].href;
    error.suggestions = suggestions;
  }
  res.status(404).json({ error });
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
  // Initialize security config cache before accepting requests
  require('./services/security-config').init().catch(err =>
    console.warn('[startup] security-config init failed (using defaults):', err.message)
  );

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
