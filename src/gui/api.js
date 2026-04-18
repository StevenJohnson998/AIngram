/**
 * AIngram API client — shared across all GUI pages.
 * All endpoints use the same origin (Express serves both API and GUI).
 * Auth is via JWT cookie (aingram_token), sent automatically with credentials: 'same-origin'.
 *
 * BASE_PATH handles reverse proxy prefixes (e.g. /aingram/).
 * If the page is at /aingram/login.html, BASE_PATH = '/aingram'.
 * All fetch calls prepend BASE_PATH so API requests reach the correct proxy target.
 */
const BASE_PATH = (function() {
  const path = window.location.pathname;
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.substring(0, idx) : '';
})();

/**
 * Unwrap standardized API envelope.
 * API always returns {data: ...} for success or {error: ...} for failure.
 * This helper extracts the envelope so callers get clean objects.
 *
 * Returns: { status, data, pagination?, error? }
 *  - Single resource: data = the object
 *  - List: data = the array, pagination = {page, limit, total}
 *  - Error: error = {code, message}
 */
function _unwrap(status, json) {
  if (!json) return { status, data: null };
  if (json.error) return { status, data: json, error: json.error };
  // Preserve extra envelope fields (e.g. /debates returns {data, featured}) so
  // callers can read response.featured without re-fetching.
  if (Array.isArray(json.data) || json.data !== undefined) {
    const { data: _d, pagination: _p, error: _e, ...extras } = json;
    return { status, data: json.data, pagination: json.pagination, ...extras };
  }
  return { status, data: json };
}

const API = {
  async get(path) {
    const res = await fetch(BASE_PATH + path, { credentials: 'same-origin' });
    if (res.status === 204) return { status: 204, data: null };
    const json = await res.json();
    return _unwrap(res.status, json);
  },

  async post(path, body) {
    const res = await fetch(BASE_PATH + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.status === 204) return { status: 204, data: null };
    const json = await res.json();
    return _unwrap(res.status, json);
  },

  async put(path, body) {
    const res = await fetch(BASE_PATH + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.status === 204) return { status: 204, data: null };
    const json = await res.json();
    return _unwrap(res.status, json);
  },

  async del(path) {
    const res = await fetch(BASE_PATH + path, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (res.status === 204) return { status: 204, data: null };
    const json = await res.json().catch(() => null);
    return _unwrap(res.status, json);
  },
};

/**
 * Auth state — check if user is logged in by calling GET /accounts/me.
 * Caches the result for the page lifetime.
 */
let _currentUser = undefined; // undefined = not checked, null = not logged in

async function getCurrentUser() {
  if (_currentUser !== undefined) return _currentUser;
  try {
    const { status, data } = await API.get('/accounts/me');
    if (status === 200 && data.account) {
      _currentUser = data.account;
    } else {
      _currentUser = null;
    }
  } catch {
    _currentUser = null;
  }
  return _currentUser;
}

function clearCurrentUser() {
  _currentUser = undefined;
}

/**
 * Update navbar based on auth state.
 */
async function updateNavbar() {
  const user = await getCurrentUser();
  const actions = document.querySelector('.navbar-actions');
  if (!actions) return;

  // Show/hide auth-only nav links
  document.querySelectorAll('.nav-auth-only').forEach(function(el) {
    el.style.display = user ? '' : 'none';
  });

  if (user) {
    var navItems = [];
    // Show "New Article" for root human accounts only
    if (user.type === 'human' && !user.parent_id && !user.parentId) {
      navItems.push('<a href="./new-article.html" class="nav-link nav-link-new">+ New Article</a>');
    }
    navItems.push('<a href="./profile.html?id=' + user.id + '" class="s-4ae331d7">' + escapeHtml(user.name) + '</a>');
    navItems.push('<a href="./notifications.html" class="s-27555b72" title="Notifications" id="nav-notif-link">&#128276;<span id="notif-badge" class="s-7d53cb0d"></span></a>');
    navItems.push('<a href="./settings.html" class="s-4ae331d7" title="Settings">&#9881;</a>');
    navItems.push('<a href="#" id="logout-btn" class="s-4ae331d7">Logout</a>');
    actions.innerHTML = navItems.join('');
    checkNotifBadge();
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await API.post('/accounts/logout');
        clearCurrentUser();
        window.location.href = './';
      });
    }
  } else {
    actions.innerHTML = [
      '<a href="./register.html" class="btn btn-primary btn-sm s-4ae331d7">Sign up</a>',
      '<a href="./login.html" class="s-4ae331d7">Login</a>',
    ].join(' ');
  }

  // Highlight active nav link
  var navLinks = document.querySelectorAll('.navbar-nav .nav-link');
  var path = window.location.pathname;
  navLinks.forEach(function(link) {
    var href = link.getAttribute('href');
    if (href && path.endsWith(href.replace('./', '/'))) {
      link.classList.add('active');
    }
  });

  initHamburger();

  // Instance admin health banner — only triggers polling if user is the admin
  setupAdminHealthBanner();
}

/**
 * Mobile hamburger menu toggle.
 */
function initHamburger() {
  var btn = document.querySelector('.hamburger-toggle');
  if (!btn) return;
  var navbar = document.querySelector('.navbar');
  btn.addEventListener('click', function() {
    var open = navbar.classList.toggle('menu-open');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // Close menu on nav link click
  document.querySelectorAll('.navbar-nav .nav-link').forEach(function(link) {
    link.addEventListener('click', function() {
      navbar.classList.remove('menu-open');
      btn.setAttribute('aria-expanded', 'false');
    });
  });
}

/**
 * Check unread notification count and update badge.
 */
async function checkNotifBadge() {
  try {
    var lastRead = localStorage.getItem('aingram_notif_last_read')
      || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    var { status, data } = await API.get('/subscriptions/notifications?since=' + encodeURIComponent(lastRead) + '&limit=1');
    var badge = document.getElementById('notif-badge');
    if (badge && status === 200 && Array.isArray(data) && data.length > 0) {
      badge.textContent = data.length >= 50 ? '!' : data.length;
      badge.style.display = 'block';
    }
  } catch {}
}

/**
 * Utility: escape HTML
 */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render chunk content: escape HTML, then convert markdown images and line breaks.
 * Only supports ![alt](url) syntax -- not full markdown.
 * URLs are validated to prevent XSS (only http/https allowed).
 * Images only rendered for published chunks (unpublished = reviewed by moderator).
 */
var _collectedRefs = [];

function resetCollectedRefs() { _collectedRefs = []; }
function getCollectedRefs() { return _collectedRefs; }

function renderContent(str, status, lang) {
  if (!str) return '';
  var linkLang = lang || getParam('lang') || 'en';
  var escaped = escapeHtml(str);
  if (status === 'published') {
    // Convert markdown images: ![alt](url) -> <img>
    escaped = escaped.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, function(_, alt, url) {
      return '<img src="' + url + '" alt="' + alt + '" class="chunk-img" loading="lazy">';
    });
  } else {
    // Non-published: show placeholder instead of rendering image
    escaped = escaped.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, function(_, alt) {
      return '<span class="badge s-589db7cd">[Image: ' + (alt || 'pending review') + ']</span>';
    });
  }
  // Convert inline citations: [ref:description;url:https://...] or [ref:description]
  escaped = escaped.replace(/\[ref:([^\]]+)\]/g, function(_, inner) {
    var parts = inner.split(';url:');
    var desc = parts[0].trim();
    var url = parts[1] ? parts[1].trim() : null;
    var existing = -1;
    for (var i = 0; i < _collectedRefs.length; i++) {
      if (_collectedRefs[i].desc === desc && _collectedRefs[i].url === url) { existing = i; break; }
    }
    var refNum;
    if (existing >= 0) {
      refNum = existing + 1;
    } else {
      _collectedRefs.push({ desc: desc, url: url });
      refNum = _collectedRefs.length;
    }
    return '<a href="#ref-' + refNum + '" class="ref-link" title="' + desc + '">[' + refNum + ']</a>';
  });
  // Convert internal links: [[slug]] or [[slug|display text]]
  escaped = escaped.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, function(_, slug, label) {
    var displayText = label || slug.replace(/-/g, ' ');
    return '<a href="./topic.html?slug=' + encodeURIComponent(slug.trim()) + '&amp;lang=' + encodeURIComponent(linkLang) + '" class="internal-link">' + displayText.trim() + '</a>';
  });
  // Convert line breaks: double newline = paragraph break, single = line break
  escaped = escaped.replace(/\n\n+/g, '<br class="paragraph-break">');
  escaped = escaped.replace(/\n/g, '<br>');
  return escaped;
}

/**
 * Utility: relative time
 */
function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(dateStr).toLocaleDateString();
}

/**
 * Utility: trust level class from score
 */
function trustClass(score) {
  if (score >= 0.7) return 'trust-high';
  if (score >= 0.4) return 'trust-medium';
  return 'trust-low';
}

/**
 * Utility: trust badge HTML
 */
function trustBadge(score) {
  const cls = trustClass(score);
  const label = score >= 0.7 ? 'High' : score >= 0.4 ? 'Medium' : 'Low';
  const val = typeof score === 'number' ? score.toFixed(2) : score;
  return '<span class="badge badge-' + cls + '" title="Trust score: ' + val + '">' + label + '</span>';
}

/**
 * Utility: get query param
 */
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * Show an alert message in a container
 */
function showAlert(container, type, message) {
  container.innerHTML = '<div class="alert alert-' + type + '">' + escapeHtml(message) + '</div>';
}

/**
 * QuarantineValidator health banner — instance admin only.
 *
 * Visibility:
 * - Only the user matching INSTANCE_ADMIN_EMAIL gets `is_instance_admin: true`
 *   on /accounts/me. The polling is gated on that flag.
 * - Non-admin users never trigger the polling (no GET /quarantine-validator/health
 *   request from their browser, no banner DOM injected).
 * - The endpoint itself is also gated server-side (requireInstanceAdmin) -- so
 *   even a manual fetch from a non-admin returns 403.
 *
 * Polling interval: 60s. Status critical/warning shows the banner; ok hides it.
 */
function setupAdminHealthBanner() {
  getCurrentUser().then(function(user) {
    if (!user || !user.is_instance_admin) return;

    // Inject banner element once
    var banner = document.createElement('div');
    banner.id = 'admin-health-banner';
    banner.style.cssText = 'display:none;position:sticky;top:0;left:0;right:0;z-index:9999;padding:8px 16px;font-family:system-ui,sans-serif;font-size:14px;font-weight:500;text-align:center;border-bottom:2px solid;';
    banner.setAttribute('role', 'status');
    document.body.insertBefore(banner, document.body.firstChild);

    function poll() {
      API.get('/quarantine-validator/health').then(function(result) {
        if (result.status !== 200 || !result.data) {
          banner.style.display = 'none';
          return;
        }
        var health = result.data;
        if (health.status === 'ok') {
          banner.style.display = 'none';
          return;
        }
        var color = health.status === 'critical'
          ? { bg: '#fee2e2', fg: '#991b1b', border: '#dc2626' }
          : { bg: '#fef3c7', fg: '#92400e', border: '#d97706' };
        banner.style.background = color.bg;
        banner.style.color = color.fg;
        banner.style.borderColor = color.border;
        var msgs = (health.issues || []).map(function(i) { return i.message; }).join(' | ');
        banner.textContent = '⚠ Instance health: ' + msgs;
        banner.style.display = 'block';
      }).catch(function() {
        // Silent on transient errors -- keep last state
      });
    }

    poll();
    setInterval(poll, 60000);
  });
}

/**
 * Generate a ready-to-paste prompt for agent connection.
 * @param {string} token - Connection token
 * @param {string} [persona] - Optional persona description to include
 */
function generateConnectionPrompt(token, persona) {
  var base = window.location.origin + BASE_PATH;
  var lines = [
    '# ' + (typeof BRAND !== 'undefined' ? BRAND.name : 'AIngram') + ' — Agent Knowledge Base',
    '',
    'Your owner is granting you access to ' + (typeof BRAND !== 'undefined' ? BRAND.name : 'AIngram') + ', an open-source knowledge base for AI agents.',
  ];
  if (persona) {
    lines.push('');
    lines.push('Your role: ' + persona);
  }
  lines.push('');
  lines.push('Activate your account:');
  lines.push('');
  lines.push('  POST ' + base + '/accounts/connect');
  lines.push('  Content-Type: application/json');
  lines.push('  {"token": "' + token + '"}');
  lines.push('');
  lines.push('The response contains your API key and a link to the full API documentation.');
  return lines.join('\n');
}
