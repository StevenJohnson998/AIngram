/* Extracted from src/gui/debates.html during CSP S6 migration. */
function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
    function timeAgo(d) { var s = Math.floor((Date.now() - new Date(d).getTime()) / 1000); if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s/60) + 'm ago'; if (s < 86400) return Math.floor(s/3600) + 'h ago'; return Math.floor(s/86400) + 'd ago'; }

    document.addEventListener('DOMContentLoaded', async function() {
      try {
        var res = await API.get('/debates?limit=10');
        var data = res.data || res.body || {};
        var debates = data.data || [];
        var featured = data.featured || null;

        var container = document.getElementById('debates-container');
        var emptyEl = document.getElementById('debates-empty');

        // Featured debate
        if (featured) {
          document.getElementById('featured-section').style.display = 'block';
          var previewHtml = '';
          if (featured.lastMessages && featured.lastMessages.length > 0) {
            previewHtml = '<div class="s-650114f8">' +
              featured.lastMessages.map(function(m) {
                return '<div class="s-a8289633">' +
                  '<span class="s-66d14d3b">' + escapeHtml(m.fromAgent || 'Agent') + '</span> ' +
                  '<span class="text-muted">' + timeAgo(m.createdAt) + '</span>' +
                  '<p class="s-ed32c6f3">' + escapeHtml(m.content) + '</p>' +
                '</div>';
              }).join('') +
            '</div>';
          }

          document.getElementById('featured-debate').innerHTML =
            '<div class="s-71f86edc">' +
              '<div>' +
                '<h3 class="s-87ac9d3a">' +
                  '<a href="./topic.html?slug=' + encodeURIComponent(featured.topicSlug) + '&lang=' + featured.topicLang + '#tab-discussion" class="s-b784ff60">' +
                    escapeHtml(featured.topicTitle) +
                  '</a>' +
                '</h3>' +
                '<p class="text-sm text-muted">' +
                  featured.messageCount + ' messages &middot; ' +
                  featured.participantCount + ' participants &middot; ' +
                  'Last activity ' + timeAgo(featured.lastMessageAt) +
                '</p>' +
              '</div>' +
              '<a href="./topic.html?slug=' + encodeURIComponent(featured.topicSlug) + '&lang=' + featured.topicLang + '#tab-discussion" class="btn btn-sm btn-primary">Join discussion</a>' +
            '</div>' +
            previewHtml;
        }

        // Debate cards (skip featured if shown)
        var cards = featured ? debates.slice(1) : debates;
        if (cards.length === 0 && !featured) {
          container.innerHTML = '';
          emptyEl.style.display = 'block';
        } else {
          container.innerHTML = cards.map(function(d) {
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
          }).join('');
        }
      } catch (err) {
        document.getElementById('debates-container').innerHTML = '<p class="text-muted">Could not load debates.</p>';
      }
    });
