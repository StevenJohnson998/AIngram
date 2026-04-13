/* Extracted from src/gui/debates.html during CSP S6 migration. */
function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
    function timeAgo(d) { var s = Math.floor((Date.now() - new Date(d).getTime()) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60) + 'm ago'; if (s < 86400) return Math.floor(s/3600) + 'h ago'; return Math.floor(s/86400) + 'd ago'; }

    function renderDebateCard(d) {
      return '<a href="./topic.html?slug=' + encodeURIComponent(d.topicSlug) + '&lang=' + d.topicLang + '#tab-discussion" class="card s-c52f9028">' +
        '<div class="flex items-center gap-sm mb-md">' +
          '<span class="badge badge-lang">' + escapeHtml((d.topicLang || 'en').toUpperCase()) + '</span>' +
          (d.topicType === 'course' ? '<span class="badge s-109a5b77">Course</span>' : '') +
        '</div>' +
        '<h3 class="s-a1d19e92">' + escapeHtml(d.topicTitle) + '</h3>' +
        '<p class="text-sm text-muted">' +
          d.messageCount + ' messages &middot; ' +
          d.participantCount + ' participants &middot; ' +
          timeAgo(d.lastMessageAt) +
        '</p>' +
      '</a>';
    }

    // Pre-existing bug surfaced during S6 testing: this page never called
    // updateNavbar(), so the navbar always showed the logged-out state even
    // for authenticated users. Adding the call here to match every other page.
    updateNavbar();

    document.addEventListener('DOMContentLoaded', function() {
      var container = document.getElementById('debates-container');
      var emptyEl = document.getElementById('debates-empty');
      var langEl = document.getElementById('filter-lang');
      var typeEl = document.getElementById('filter-topic-type');
      var daysEl = document.getElementById('filter-days');

      async function loadDebates() {
        container.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
        emptyEl.style.display = 'none';
        try {
          var days = daysEl.value || '7';
          var res = await API.get('/debates?limit=20&days=' + encodeURIComponent(days));
          var debates = res.data || [];
          var lang = langEl.value;
          var type = typeEl.value;
          var filtered = debates.filter(function(d) {
            if (lang && d.topicLang !== lang) return false;
            if (type && d.topicType !== type) return false;
            return true;
          });
          if (filtered.length === 0) {
            container.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
          }
          container.innerHTML = filtered.map(renderDebateCard).join('');
        } catch (err) {
          container.innerHTML = '<p class="text-muted">Could not load debates.</p>';
        }
      }

      langEl.addEventListener('change', loadDebates);
      typeEl.addEventListener('change', loadDebates);
      daysEl.addEventListener('change', loadDebates);
      loadDebates();
    });
