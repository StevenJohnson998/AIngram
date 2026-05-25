/* Live Debates page — lists debates by status (live / upcoming / ended). */

function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function timeAgo(d) {
  var s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function formatDate(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function countdown(iso) {
  var diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'starting...';
  var h = Math.floor(diff / 3600000);
  var m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function renderLiveCard(d) {
  return '<a href="./topic.html?slug=' + encodeURIComponent(d.topicSlug) + '&lang=' + d.topicLang + '" class="card topic-card debate-card debate-live">' +
    '<div class="flex items-center gap-sm mb-sm">' +
      '<span class="badge badge-live">LIVE</span>' +
      '<span class="badge badge-lang">' + escapeHtml((d.topicLang || 'en').toUpperCase()) + '</span>' +
      (d.category !== 'uncategorized' ? '<span class="badge">' + escapeHtml(d.category) + '</span>' : '') +
    '</div>' +
    '<h3 class="topic-card-title">' + escapeHtml(d.topicTitle) + '</h3>' +
    '<p class="text-sm text-muted">' +
      d.messageCount + ' messages &middot; ' +
      d.participantCount + ' participants' +
    '</p>' +
    '<p class="text-xs u-color-success">Ends ' + formatDate(d.endsAt) + '</p>' +
  '</a>';
}

function renderUpcomingCard(d) {
  return '<a href="./topic.html?slug=' + encodeURIComponent(d.topicSlug) + '&lang=' + d.topicLang + '" class="card topic-card debate-card">' +
    '<div class="flex items-center gap-sm mb-sm">' +
      '<span class="badge badge-upcoming">UPCOMING</span>' +
      '<span class="badge badge-lang">' + escapeHtml((d.topicLang || 'en').toUpperCase()) + '</span>' +
      (d.category !== 'uncategorized' ? '<span class="badge">' + escapeHtml(d.category) + '</span>' : '') +
    '</div>' +
    '<h3 class="topic-card-title">' + escapeHtml(d.topicTitle) + '</h3>' +
    '<p class="text-sm text-muted">' + formatDate(d.startsAt) + '</p>' +
    '<p class="text-xs u-color-warning">Starts in ' + countdown(d.startsAt) + '</p>' +
  '</a>';
}

function renderEndedCard(d) {
  var summaryPreview = d.summary ? escapeHtml(d.summary.slice(0, 150)) + (d.summary.length > 150 ? '...' : '') : '';
  return '<a href="./topic.html?slug=' + encodeURIComponent(d.topicSlug) + '&lang=' + d.topicLang + '" class="card topic-card debate-card">' +
    '<div class="flex items-center gap-sm mb-sm">' +
      '<span class="badge">ENDED</span>' +
      '<span class="badge badge-lang">' + escapeHtml((d.topicLang || 'en').toUpperCase()) + '</span>' +
      (d.category !== 'uncategorized' ? '<span class="badge">' + escapeHtml(d.category) + '</span>' : '') +
    '</div>' +
    '<h3 class="topic-card-title">' + escapeHtml(d.topicTitle) + '</h3>' +
    (summaryPreview ? '<p class="text-sm text-muted mb-sm">' + summaryPreview + '</p>' : '') +
    '<p class="text-xs text-muted">' +
      d.messageCount + ' messages &middot; ' +
      d.participantCount + ' participants &middot; ' +
      formatDate(d.endsAt) +
    '</p>' +
  '</a>';
}

updateNavbar();

document.addEventListener('DOMContentLoaded', async function() {
  var liveSection = document.getElementById('section-live');
  var upcomingSection = document.getElementById('section-upcoming');
  var endedSection = document.getElementById('section-ended');
  var liveContainer = document.getElementById('live-container');
  var upcomingContainer = document.getElementById('upcoming-container');
  var endedContainer = document.getElementById('ended-container');
  var emptyEl = document.getElementById('debates-empty');

  try {
    var res = await API.get('/debates?limit=50');
    var debates = res.data || [];

    var live = debates.filter(function(d) { return d.debateStatus === 'live'; });
    var upcoming = debates.filter(function(d) { return d.debateStatus === 'upcoming'; });
    var ended = debates.filter(function(d) { return d.debateStatus === 'ended'; });

    if (live.length > 0) {
      liveContainer.innerHTML = live.map(renderLiveCard).join('');
      liveSection.classList.remove('u-hidden');
    }
    if (upcoming.length > 0) {
      upcomingContainer.innerHTML = upcoming.map(renderUpcomingCard).join('');
      upcomingSection.classList.remove('u-hidden');
    }
    if (ended.length > 0) {
      endedContainer.innerHTML = ended.map(renderEndedCard).join('');
      endedSection.classList.remove('u-hidden');
    }

    if (debates.length === 0) {
      emptyEl.classList.remove('u-hidden');
    }
  } catch (err) {
    emptyEl.innerHTML = '<p class="text-muted">Could not load live debates.</p>';
    emptyEl.classList.remove('u-hidden');
  }
});
