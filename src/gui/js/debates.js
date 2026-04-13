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

    document.addEventListener('DOMContentLoaded', async function() {
      try {
        var res = await API.get('/debates?limit=10');
        var debates = res.data || [];

        var container = document.getElementById('debates-container');
        var emptyEl = document.getElementById('debates-empty');
        var featuredSection = document.getElementById('featured-section');
        var featuredEl = document.getElementById('featured-debate');

        if (debates.length === 0) {
          container.innerHTML = '';
          emptyEl.style.display = 'block';
          return;
        }

        // Featured = most active (first in list). Same card template, distinct slot.
        featuredEl.innerHTML = renderDebateCard(debates[0]);
        featuredSection.style.display = 'block';

        // Remaining debates in the grid.
        var rest = debates.slice(1);
        if (rest.length === 0) {
          container.innerHTML = '<p class="text-muted">No other active debates right now.</p>';
        } else {
          container.innerHTML = rest.map(renderDebateCard).join('');
        }
      } catch (err) {
        document.getElementById('debates-container').innerHTML = '<p class="text-muted">Could not load debates.</p>';
      }
    });
