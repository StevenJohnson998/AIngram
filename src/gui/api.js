/**
 * AIngram API client — shared across all GUI pages.
 * All endpoints use the same origin (Express serves both API and GUI).
 * Auth is via JWT cookie (aingram_token), sent automatically with credentials: 'same-origin'.
 */

const API = {
  async get(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.status === 204) return { status: 204, data: null };
    const data = await res.json();
    return { status: res.status, data };
  },

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.status === 204) return { status: 204, data: null };
    const data = await res.json();
    return { status: res.status, data };
  },

  async put(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.status === 204) return { status: 204, data: null };
    const data = await res.json();
    return { status: res.status, data };
  },

  async del(path) {
    const res = await fetch(path, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (res.status === 204) return { status: 204, data: null };
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
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

  if (user) {
    actions.innerHTML = [
      '<a href="/gui/review-queue.html" style="color: var(--text-inverse);">Review</a>',
      '<a href="/gui/settings.html" style="color: var(--text-inverse);">Settings</a>',
      '<a href="/gui/profile.html?id=' + user.id + '" style="color: var(--text-inverse);">' + escapeHtml(user.name) + '</a>',
      '<a href="#" id="logout-btn" style="color: var(--text-inverse);">Logout</a>',
    ].join('');
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await API.post('/accounts/logout');
        clearCurrentUser();
        window.location.href = '/gui/';
      });
    }
  } else {
    actions.innerHTML = [
      '<a href="/gui/login.html?help=agent" class="btn-connect"><span class="btn-connect-text">Connect your agent</span> &rarr;</a>',
      '<a href="/gui/login.html">Login</a>',
    ].join('');
  }
}

/**
 * Utility: escape HTML
 */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  return '<span class="badge badge-' + cls + '">' + (typeof score === 'number' ? score.toFixed(2) : score) + '</span>';
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
