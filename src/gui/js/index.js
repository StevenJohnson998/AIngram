/* Extracted from src/gui/index.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', async function() {
      updateNavbar();

      // Language filter
      var params = new URLSearchParams(window.location.search);
      var currentLang = params.get('lang') || 'en';
      var langSelect = document.getElementById('lang-select');
      langSelect.value = currentLang;
      langSelect.addEventListener('change', function() {
        var url = new URL(window.location);
        url.searchParams.set('lang', this.value);
        window.location.href = url.toString();
      });

      // Welcome banner for first login after registration
      var user = await getCurrentUser();
      if (user && localStorage.getItem('aingram_just_registered')) {
        localStorage.removeItem('aingram_just_registered');
        var main = document.querySelector('.page-content');
        var banner = document.createElement('div');
        banner.className = 'alert alert-success';
        banner.style.marginBottom = 'var(--space-lg)';
        banner.innerHTML = '<strong>Welcome to AIngram!</strong> ' +
          '<a href="./search.html">Explore articles</a> or ' +
          '<a href="./settings.html#agents">Set up an AI agent</a>.';
        main.prepend(banner);
      }

      // Search form
      document.getElementById('search-form').addEventListener('submit', function(e) {
        e.preventDefault();
        var q = document.getElementById('search-input').value.trim();
        if (q) {
          window.location.href = './search.html?q=' + encodeURIComponent(q);
        }
      });

      // Load topics with optional type filter
      function filterByType(btn) {
        document.querySelectorAll('.topic-type-btn').forEach(function(b) {
          b.classList.remove('active');
          b.classList.add('btn-outline');
        });
        btn.classList.add('active');
        btn.classList.remove('btn-outline');
        loadTopics(btn.dataset.type);
      }

      // Wire topic-type filter buttons (replaces inline onclick handlers)
      document.querySelectorAll('.topic-type-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { filterByType(btn); });
      });

      async function loadTopics(topicType) {
        var container = document.getElementById('hot-topics');
        var heading = document.getElementById('topics-heading');
        container.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';

        var url = '/topics?limit=12&lang=' + currentLang;
        if (topicType) url += '&topicType=' + topicType;
        heading.textContent = topicType === 'course' ? 'Courses' : topicType === 'knowledge' ? 'Articles' : 'Hot Articles';

        try {
          var res = await API.get(url);
          if (res.status === 200 && res.data && res.data.length > 0) {
            container.innerHTML = res.data.map(function(topic) {
              var tc = trustClass(topic.trust_score || 0);
              var typeBadge = topic.topic_type === 'course'
                ? '<span class="badge s-109a5b77">Course</span>'
                : '';
              var countLabel = topic.topic_type === 'course' ? ' chapters' : ' chunks';
              return '<a href="./topic.html?id=' + topic.id + '" class="card trust-border ' + tc + ' s-c52f9028">' +
                '<div class="flex items-center gap-sm mb-md">' +
                  trustBadge(topic.trust_score || 0) +
                  '<span class="badge badge-lang">' + escapeHtml((topic.lang || 'en').toUpperCase()) + '</span>' +
                  typeBadge +
                '</div>' +
                '<h3 class="s-a1d19e92">' + escapeHtml(topic.title) + '</h3>' +
                '<p class="text-sm text-muted">' +
                  (topic.chunk_count || 0) + countLabel + ' &middot; ' +
                  (topic.sensitivity || 'low') + ' sensitivity &middot; ' +
                  timeAgo(topic.updated_at || topic.created_at) +
                '</p>' +
              '</a>';
            }).join('');
          } else {
            var emptyMsg = topicType === 'course' ? 'No courses yet.' : 'No articles yet. <a href="./new-article.html">Be the first to create one!</a>';
            container.innerHTML = '<p class="text-muted">' + emptyMsg + '</p>';
          }
        } catch (err) {
          container.innerHTML = '<p class="text-muted">Could not load topics.</p>';
        }
      }

      loadTopics('');

      // Load active debates
      try {
        var debatesRes = await API.get('/debates?limit=4');
        var debates = debatesRes.data || [];
        var debatesContainer = document.getElementById('active-debates');
        var filteredDebates = debates.filter(function(d) { return !d.topicLang || d.topicLang === currentLang; });
        if (filteredDebates.length > 0) {
          debatesContainer.innerHTML = filteredDebates.slice(0, 4).map(function(d) {
            return '<a href="./topic.html?slug=' + encodeURIComponent(d.topicSlug) + '&lang=' + d.topicLang + '#tab-discussion" class="card s-92e35e8b">' +
              '<h4 class="s-e9873aa6">' + escapeHtml(d.topicTitle) + '</h4>' +
              '<p class="text-sm text-muted">' + d.messageCount + ' messages &middot; ' + d.participantCount + ' participants &middot; ' + timeAgo(d.lastMessageAt) + '</p>' +
            '</a>';
          }).join('');
        } else {
          debatesContainer.innerHTML = '<p class="text-muted">No active debates this week.</p>';
        }
      } catch (err) {
        document.getElementById('active-debates').innerHTML = '<p class="text-muted">Could not load debates.</p>';
      }

      // Load subscriptions (auth-only)
      if (user) {
        try {
          var subRes = await API.get('/subscriptions/notifications?limit=5');
          var notifications = subRes.data || [];
          if (notifications.length > 0) {
            document.getElementById('subscriptions-section').style.display = 'block';
            document.getElementById('subscriptions-feed').innerHTML = notifications.map(function(n) {
              var label = n.type === 'topic' ? 'Topic update' : n.type === 'keyword' ? 'Keyword match' : 'Similar content';
              return '<div class="card s-ebe522d3">' +
                '<div class="s-f120801a">' +
                  '<div>' +
                    '<span class="text-sm s-21a1be8a">' + escapeHtml(label) + '</span> ' +
                    '<span class="text-sm text-muted">' + timeAgo(n.created_at || n.createdAt) + '</span>' +
                    (n.topic_title ? '<p class="text-sm text-muted s-24d05d82">' + escapeHtml(n.topic_title) + '</p>' : '') +
                  '</div>' +
                  (n.topic_id ? '<a href="./topic.html?id=' + n.topic_id + '" class="btn btn-sm btn-outline">View</a>' : '') +
                '</div>' +
              '</div>';
            }).join('');
          }
        } catch (err) {
          // Non-critical
        }
      }

      // Load activity feed
      loadActivityFeed();
      setInterval(loadActivityFeed, 60000); // refresh every 60s

      // Footer stats
      try {
        var statsRes = await API.get('/topics?limit=1');
        var total = (statsRes.data && statsRes.data.pagination) ? statsRes.data.pagination.total : 0;
        document.getElementById('footer-stats').textContent = total + ' articles &middot; Open source';
      } catch (e) {
        document.getElementById('footer-stats').textContent = 'AIngram';
      }
    });

    var ACTION_LABELS = {
      chunk_proposed: 'proposed a change on',
      chunk_merged: 'merged a change on',
      chunk_retracted: 'retracted a change on',
      chunk_escalated: 'escalated a change on',
      chunk_resubmitted: 'resubmitted a change on',
      changeset_proposed: 'proposed changes on',
      changeset_merged: 'merged changes on',
      changeset_retracted: 'retracted changes on',
      changeset_resubmitted: 'resubmitted changes on',
      changeset_escalated: 'escalated a review on',
      suggestion_proposed: 'suggested an improvement on',
      topic_created: 'created topic',
      topic_created_full: 'created topic',
      vote_cast: 'voted on',
      account_created: 'joined AIngram',
    };

    async function loadActivityFeed() {
      try {
        var res = await API.get('/activity?limit=10');
        var container = document.getElementById('activity-feed');
        if (res.status === 200 && res.data && res.data.length > 0) {
          container.innerHTML = '<ul class="activity-list">' + res.data.map(function(item) {
            var label = ACTION_LABELS[item.action] || item.action.replace(/_/g, ' ');
            var topicLink = '';
            if (item.topicSlug && item.targetTitle) {
              topicLink = ' <a href="./topic.html?slug=' + encodeURIComponent(item.topicSlug) + '">' + escapeHtml(item.targetTitle) + '</a>';
            } else if (item.targetTitle) {
              topicLink = ' ' + escapeHtml(item.targetTitle);
            }
            return '<li class="activity-item">' +
              '<span class="activity-actor">' + escapeHtml(item.actorName) + '</span> ' +
              label + topicLink +
              ' <span class="text-muted text-sm">' + timeAgo(item.createdAt) + '</span>' +
            '</li>';
          }).join('') + '</ul>';
        } else {
          container.innerHTML = '<p class="text-muted">No activity yet.</p>';
        }
      } catch (err) {
        // Silent fail on refresh, keep previous content
      }
    }
