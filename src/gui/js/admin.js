/**
 * Admin dashboard — ban review + stats.
 * Requires instance admin or policing badge.
 */
(function () {
  'use strict';

  let currentFlagId = null;

  async function init() {
    const me = await API.get('/accounts/me');
    if (me.status !== 200) {
      showError('You must be logged in to access the admin dashboard.');
      return;
    }
    const account = me.data;
    const isAdmin = account.is_instance_admin || account.badge_policing;
    if (!isAdmin) {
      showError('Admin access required (instance admin or policing badge).');
      return;
    }

    document.getElementById('admin-loading').classList.add('hidden');
    document.getElementById('admin-content').classList.remove('hidden');

    setupTabs();
    setupBanReviewHandlers();
    setupModalHandlers();

    await Promise.all([loadStats(), loadBanReviews()]);
  }

  function showError(message) {
    document.getElementById('admin-loading').classList.add('hidden');
    const errEl = document.getElementById('admin-error');
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  }

  function setupTabs() {
    const tabs = document.querySelectorAll('.admin-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        document.querySelectorAll('.admin-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById('panel-' + target).classList.remove('hidden');
        if (target === 'stats') loadStats();
        if (target === 'ban-reviews') loadBanReviews();
      });
    });
  }

  function setupBanReviewHandlers() {
    document.getElementById('refresh-ban-reviews').addEventListener('click', loadBanReviews);
    document.getElementById('filter-ban-status').addEventListener('change', loadBanReviews);
  }

  function setupModalHandlers() {
    const modal = document.getElementById('ban-detail-modal');
    document.getElementById('ban-detail-close').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('ban-detail-cancel').addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('ban-detail-confirm').addEventListener('click', handleConfirm);
    document.getElementById('ban-detail-dismiss').addEventListener('click', handleDismiss);
  }

  async function loadStats() {
    const res = await API.get('/admin/stats');
    if (res.status !== 200) {
      document.getElementById('stats-grid').innerHTML = '<p class="text-error">Failed to load stats</p>';
      return;
    }
    const s = res.data;
    const cards = [
      { label: 'Ban reviews pending', value: s.ban_reviews_pending, urgent: s.ban_reviews_pending > 0 },
      { label: 'Escalated to human', value: s.ban_reviews_escalated, urgent: s.ban_reviews_escalated > 0 },
      { label: 'Open flags (all)', value: s.flags_open },
      { label: 'Active bans', value: s.active_bans },
      { label: 'Bans (last 24h)', value: s.bans_last_24h },
      { label: 'Bans (last 7 days)', value: s.bans_last_7d },
    ];
    document.getElementById('stats-grid').innerHTML = cards.map(c =>
      `<div class="stat-card"><div class="stat-label">${escapeHtml(c.label)}</div><div class="stat-value">${c.value}</div></div>`
    ).join('');

    // Update tab counter
    const counter = document.getElementById('count-ban-reviews');
    counter.textContent = s.ban_reviews_pending;
    counter.classList.toggle('has-pending', s.ban_reviews_pending > 0);
  }

  async function loadBanReviews() {
    const status = document.getElementById('filter-ban-status').value;
    const res = await API.get('/admin/ban-reviews?status=' + encodeURIComponent(status));
    const list = document.getElementById('ban-reviews-list');
    if (res.status !== 200) {
      list.innerHTML = '<p class="text-error">Failed to load ban reviews</p>';
      return;
    }
    const flags = res.data;
    if (flags.length === 0) {
      list.innerHTML = '<p class="text-muted">No ban reviews match the current filter.</p>';
      return;
    }
    list.innerHTML = flags.map(f => {
      const accountLabel = (f.account_name || '(unknown)') + (f.owner_email ? ' <' + f.owner_email + '>' : '');
      const age = relativeTime(f.created_at);
      return `<div class="ban-review-row" data-flag-id="${f.flag_id}">
        <div>
          <div><strong>${escapeHtml(accountLabel)}</strong></div>
          <div class="text-sm text-muted">${escapeHtml(f.reason || '(no reason)').substring(0, 160)}...</div>
        </div>
        <div class="text-sm">Score: <strong>${Number(f.cumulative_score || 0).toFixed(2)}</strong><br/><span class="text-muted">${f.detection_count} detections</span></div>
        <div class="text-sm">Age: ${age}<br/><span class="text-muted">${f.review_status || 'pending'}</span></div>
        <div><span class="ban-review-status ${f.status}">${f.status}</span></div>
      </div>`;
    }).join('');
    list.querySelectorAll('.ban-review-row').forEach(row => {
      row.addEventListener('click', () => openDetailModal(row.dataset.flagId));
    });
  }

  async function openDetailModal(flagId) {
    currentFlagId = flagId;
    const modal = document.getElementById('ban-detail-modal');
    const body = document.getElementById('ban-detail-body');
    body.innerHTML = 'Loading...';
    modal.classList.remove('hidden');

    const res = await API.get('/admin/ban-reviews/' + encodeURIComponent(flagId));
    if (res.status !== 200) {
      body.innerHTML = '<p class="text-error">Failed to load flag detail</p>';
      return;
    }
    const f = res.data;
    const detections = (f.recent_detections || []).map(d =>
      `<div class="detection-log">
        <div class="log-meta">score=${Number(d.score).toFixed(2)} field=${escapeHtml(d.field_type)} flags=[${(d.flags || []).map(escapeHtml).join(', ')}] at ${new Date(d.created_at).toLocaleString()}</div>
        <div class="log-preview">${escapeHtml(d.content_preview || '(no preview)')}</div>
      </div>`
    ).join('');

    body.innerHTML = `
      <h3>${escapeHtml(f.account_name || '(unknown account)')}</h3>
      <p class="text-sm text-muted">${escapeHtml(f.owner_email || '')} &middot; ${escapeHtml(f.account_type)} &middot; created ${new Date(f.account_created_at).toLocaleDateString()}</p>
      <p><strong>Current status:</strong> flag=${escapeHtml(f.status)}, review_status=${escapeHtml(f.review_status || 'n/a')}</p>
      <p><strong>Cumulative score:</strong> ${Number(f.cumulative_score || 0).toFixed(2)}</p>
      <p><strong>Flag created:</strong> ${new Date(f.created_at).toLocaleString()}</p>
      <p><strong>Reason:</strong><br/>${escapeHtml(f.reason || '(no reason)')}</p>
      <h4>Recent detections (${(f.recent_detections || []).length})</h4>
      ${detections || '<p class="text-muted">No detection logs available.</p>'}
    `;
  }

  async function handleConfirm() {
    if (!currentFlagId) return;
    if (!confirm('Confirm ban? This will permanently ban the account and send a notification email.')) return;
    const res = await API.post('/admin/ban-reviews/' + encodeURIComponent(currentFlagId) + '/confirm', {});
    if (res.status !== 200) {
      alert('Failed: ' + (res.error?.message || 'unknown error'));
      return;
    }
    document.getElementById('ban-detail-modal').classList.add('hidden');
    await Promise.all([loadStats(), loadBanReviews()]);
  }

  async function handleDismiss() {
    if (!currentFlagId) return;
    if (!confirm('Dismiss flag and unblock account? The account score will be reset.')) return;
    const res = await API.post('/admin/ban-reviews/' + encodeURIComponent(currentFlagId) + '/dismiss', {});
    if (res.status !== 200) {
      alert('Failed: ' + (res.error?.message || 'unknown error'));
      return;
    }
    document.getElementById('ban-detail-modal').classList.add('hidden');
    await Promise.all([loadStats(), loadBanReviews()]);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function relativeTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
