/* Extracted from src/gui/notifications.html during CSP S6 migration. */
updateNavbar();

    var LAST_READ_KEY = 'aingram_notif_last_read';

    function getLastRead() {
      return localStorage.getItem(LAST_READ_KEY) || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    function markAllRead() {
      localStorage.setItem(LAST_READ_KEY, new Date().toISOString());
      document.querySelectorAll('.notif-item.notif-unread').forEach(function(el) {
        el.classList.remove('notif-unread');
      });
      document.getElementById('mark-read-btn').style.display = 'none';
    }

    async function loadNotifications() {
      var user = await getCurrentUser();
      if (!user) {
        window.location.href = './login.html';
        return;
      }

      var since = getLastRead();
      try {
        // Get all recent notifications (past 7 days)
        var sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        var { status, data } = await API.get('/subscriptions/notifications?since=' + encodeURIComponent(sevenDaysAgo) + '&limit=50');

        document.getElementById('notif-loading').style.display = 'none';

        if (status !== 200 || !Array.isArray(data) || data.length === 0) {
          document.getElementById('notif-empty').style.display = 'block';
          return;
        }

        var hasUnread = false;
        var html = data.map(function(notif) {
          var isUnread = new Date(notif.created_at || notif.matched_at) > new Date(since);
          if (isUnread) hasUnread = true;

          var matchLabel = notif.match_type === 'vector' ? 'Semantic match'
            : notif.match_type === 'keyword' ? 'Keyword match'
            : 'Topic update';

          var similarity = notif.similarity ? ' (' + (notif.similarity * 100).toFixed(0) + '%)' : '';
          var preview = escapeHtml((notif.content_preview || notif.content || '').substring(0, 150));
          var topicLink = notif.topic_slug
            ? '<a href="./topic.html?slug=' + encodeURIComponent(notif.topic_slug) + '">' + escapeHtml(notif.topic_title || notif.topic_slug) + '</a>'
            : '';

          return '<div class="notif-item' + (isUnread ? ' notif-unread' : '') + '">'
            + '<div class="notif-header">'
            + '<span class="badge badge-sm">' + matchLabel + similarity + '</span>'
            + '<span class="text-muted">' + timeAgo(notif.created_at || notif.matched_at) + '</span>'
            + '</div>'
            + (topicLink ? '<div class="notif-topic">' + topicLink + '</div>' : '')
            + '<div class="notif-preview">' + preview + '</div>'
            + '</div>';
        }).join('');

        document.getElementById('notif-list').innerHTML = html;
        document.getElementById('notif-list').style.display = 'block';

        if (hasUnread) {
          document.getElementById('mark-read-btn').style.display = 'inline-block';
        }
      } catch (err) {
        document.getElementById('notif-loading').style.display = 'none';
        document.getElementById('notif-empty').style.display = 'block';
        document.getElementById('notif-empty').innerHTML = '<p class="text-muted">Failed to load notifications.</p>';
      }
    }

    loadNotifications();
    document.getElementById('mark-read-btn').addEventListener('click', markAllRead);
