/* Extracted from src/gui/search.html during CSP S6 migration. */
var currentQuery = '';

    var FEATURED_COURSE_IDS = (typeof BRAND !== 'undefined' && BRAND.pinned && BRAND.pinned.courses) ? BRAND.pinned.courses : [];

    async function loadFeaturedCourses() {
      var section = document.getElementById('featured-courses');
      var grid = document.getElementById('featured-courses-grid');
      if (!section || !grid) return;

      var cards = [];
      for (var i = 0; i < FEATURED_COURSE_IDS.length; i++) {
        try {
          var res = await API.get('/topics/' + FEATURED_COURSE_IDS[i]);
          if (res.status === 200 && res.data) cards.push(res.data);
        } catch (e) { /* skip unavailable */ }
      }

      if (cards.length === 0) return;

      grid.innerHTML = cards.map(function(topic) {
        var chapCount = topic.chunk_count || 0;
        return '<a href="./topic.html?id=' + topic.id + '" class="featured-course-card">' +
          '<div class="featured-course-header">' +
            '<div class="featured-course-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 1.1 2.7 3 6 3s6-1.9 6-3v-5"/></svg></div>' +
            '<div class="featured-course-title">' + escapeHtml(topic.title) + '</div>' +
          '</div>' +
          (topic.summary ? '<div class="featured-course-summary">' + escapeHtml(topic.summary) + '</div>' : '') +
          '<div class="featured-course-meta">' +
            '<span>' + chapCount + ' chapter' + (chapCount !== 1 ? 's' : '') + '</span>' +
          '</div>' +
        '</a>';
      }).join('');

      section.style.display = 'block';
    }

    document.addEventListener('DOMContentLoaded', function() {
      updateNavbar();

      // Swap pillar-big / pillar-small based on topicType param so the current
      // page's pillar is the visually emphasised one.
      var topicTypeParam = getParam('topicType');
      if (topicTypeParam === 'course') {
        var articles = document.querySelector('.pillar-articles');
        var courses = document.querySelector('.pillar-courses');
        if (articles) { articles.classList.remove('pillar-big'); articles.classList.add('pillar-small'); }
        if (courses) { courses.classList.remove('pillar-small'); courses.classList.add('pillar-big'); }
        document.getElementById('filter-topic-type').value = 'course';
        loadFeaturedCourses();
      } else if (!topicTypeParam) {
        document.getElementById('filter-topic-type').value = 'knowledge';
      }

      var q = getParam('q') || '';
      if (q) {
        document.getElementById('search-input').value = q;
        doSearch(q);
      } else {
        // No query: show recent topics as default
        loadRecentTopics();
      }

      document.getElementById('search-form').addEventListener('submit', function(e) {
        e.preventDefault();
        var q = document.getElementById('search-input').value.trim();
        if (q) {
          // Update URL without reload
          history.pushState(null, '', './search.html?q=' + encodeURIComponent(q));
          doSearch(q);
        }
      });

      document.getElementById('filter-type').addEventListener('change', function() {
        var q = document.getElementById('search-input').value.trim();
        if (q) doSearch(q);
      });

      document.getElementById('filter-lang').addEventListener('change', function() {
        var q = document.getElementById('search-input').value.trim();
        if (q) doSearch(q);
        else loadRecentTopics();
      });

      document.getElementById('filter-topic-type').addEventListener('change', function() {
        var q = document.getElementById('search-input').value.trim();
        if (q) doSearch(q);
        else loadRecentTopics();
      });

      document.getElementById('filter-category').addEventListener('change', function() {
        var q = document.getElementById('search-input').value.trim();
        if (q) doSearch(q);
        else loadRecentTopics();
      });

      document.getElementById('load-more-btn').addEventListener('click', function() {
        if (!window._searchResults) return;
        var container = document.getElementById('results-container');
        container.innerHTML = renderResultCards(window._searchResults, currentQuery);
        this.parentElement.style.display = 'none';
        if (window._searchResults.length >= 50) {
          showMaxBanner(container);
        }
      });
    });

    var user = null;
    getCurrentUser().then(function(u) { user = u; });

    function renderResultCards(items, q) {
      return items.map(function(item) {
        var tc = trustClass(item.trust_score || 0);
        var topicLink = item.topic_id ? './topic.html?id=' + item.topic_id : '#';
        var topicTitle = item.topic_title || 'Unknown topic';
        var topicLang = (item.topic_lang || 'en').toUpperCase();
        return '<div class="card trust-border ' + tc + ' mb-md">' +
          '<div class="flex items-center gap-sm mb-sm">' +
            '<a href="' + topicLink + '" class="search-result-title">' + escapeHtml(topicTitle) + '</a>' +
            '<div class="search-result-badges">' +
              trustBadge(item.trust_score || 0) +
              '<span class="badge badge-lang">' + escapeHtml(topicLang) + '</span>' +
            '</div>' +
          '</div>' +
          '<p class="text-sm text-secondary search-snippet">' + escapeHtml(truncate(item.content_preview || item.content || '', 200)) + '</p>' +
          '<div class="meta-row mt-sm">' +
            '<span class="text-sm text-muted">' + timeAgo(item.updated_at || item.created_at) + '</span>' +
          '</div>' +
          (user ? '<button class="btn btn-xs btn-outline mt-sm subscribe-similar-btn" data-query="' + escapeHtml(q).replace(/"/g, '&quot;') + '">Subscribe to similar</button>' : '') +
        '</div>';
      }).join('');
    }

    function showMaxBanner(container) {
      var banner = document.createElement('div');
      banner.id = 'max-results-banner';
      banner.className = 'alert alert-info';
      banner.style.marginTop = 'var(--space-lg)';
      banner.textContent = 'Maximum of 50 results reached. Please refine your search for more specific results.';
      container.after(banner);
    }

    async function loadRecentTopics() {
      var topicType = document.getElementById('filter-topic-type').value;
      var lang = document.getElementById('filter-lang').value;
      var category = document.getElementById('filter-category').value;
      var url = '/topics?limit=20';
      if (topicType) url += '&topicType=' + topicType;
      if (lang) url += '&lang=' + lang;
      if (category) url += '&category=' + category;

      var container = document.getElementById('results-container');
      container.innerHTML = '';

      try {
        var res = await API.get(url);
        if (res.status === 200 && res.data && res.data.length > 0) {
          var infoEl = document.getElementById('results-info');
          var label = topicType === 'course' ? 'courses' : 'articles';
          if (infoEl) {
            infoEl.style.display = 'block';
            infoEl.textContent = 'Recent ' + label;
          }

          container.innerHTML = res.data.map(function(topic) {
            var tc = trustClass(topic.trust_score || 0);
            var countLabel = topic.topic_type === 'course' ? ' chapters' : ' contributions';
            var typeBadge = topic.topic_type === 'course'
              ? '<span class="badge s-109a5b77">Course</span> '
              : '';
            var catBadge = (topic.category && topic.category !== 'uncategorized')
              ? '<span class="badge badge-category">' + escapeHtml(topic.category) + '</span> '
              : '';
            return '<a href="./topic.html?id=' + topic.id + '" class="card trust-border ' + tc + ' mb-md search-result">' +
              '<div class="flex items-center gap-sm mb-sm">' +
                '<span class="search-result-title">' + escapeHtml(topic.title) + '</span>' +
                '<div class="search-result-badges">' +
                  trustBadge(topic.trust_score || 0) +
                  typeBadge + catBadge +
                '</div>' +
              '</div>' +
              (topic.summary ? '<p class="text-sm text-secondary search-snippet">' + escapeHtml(topic.summary.substring(0, 200)) + '</p>' : '') +
              '<div class="meta-row mt-sm">' +
                '<span class="badge badge-lang">' + (topic.lang || 'en').toUpperCase() + '</span>' +
                '<span class="sep">&middot;</span>' +
                '<span class="text-sm text-muted">' + (topic.chunk_count || 0) + countLabel + '</span>' +
                '<span class="sep">&middot;</span>' +
                '<span class="text-sm text-muted">' + timeAgo(topic.updated_at || topic.created_at) + '</span>' +
              '</div>' +
            '</a>';
          }).join('');
        } else {
          var emptyLabel = topicType === 'course' ? 'courses' : 'articles';
          var emptyIcon = topicType === 'course'
            ? '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 1.1 2.7 3 6 3s6-1.9 6-3v-5"/></svg>'
            : '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>';
          container.innerHTML = '<div class="s-8dbfdca5"><div class="s-4bbb9ada">' + emptyIcon + '</div><p class="text-muted">No ' + emptyLabel + ' yet.</p></div>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-muted">Could not load topics.</p>';
      }
    }

    async function doSearch(q) {
      currentQuery = q;

      var type = document.getElementById('filter-type').value;
      var lang = document.getElementById('filter-lang').value;
      var topicType = document.getElementById('filter-topic-type').value;
      var category = document.getElementById('filter-category').value;

      var container = document.getElementById('results-container');
      container.innerHTML = '<p class="text-muted" id="results-loading"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Searching...</p><p class="text-muted" id="results-empty" class="s-5790ffba">No results found.</p>';
      var oldBanner = document.getElementById('max-results-banner');
      if (oldBanner) oldBanner.remove();

      var SEARCH_MAX = 50;
      var INITIAL_DISPLAY = 15;
      var url = '/search?q=' + encodeURIComponent(q) + '&type=' + type + '&page=1&limit=' + SEARCH_MAX;
      if (lang) url += '&lang=' + lang;
      if (topicType) url += '&topicType=' + topicType;
      if (category) url += '&category=' + category;

      try {
        var res = await API.get(url);
        var loadingAfter = document.getElementById('results-loading');
        if (loadingAfter) loadingAfter.style.display = 'none';

        if (res.status === 200 && res.data && res.data) {
          var results = res.data;
          var hitMax = results.length >= SEARCH_MAX;

          // Info line
          var infoEl = document.getElementById('results-info');
          if (infoEl) {
            infoEl.style.display = 'block';
            if (hitMax) {
              infoEl.textContent = 'Too many results \u2014 showing top ' + SEARCH_MAX;
            } else {
              infoEl.textContent = results.length + ' result' + (results.length !== 1 ? 's' : '');
            }
          }

          if (results.length === 0) {
            var emptyAfter = document.getElementById('results-empty');
            if (emptyAfter) emptyAfter.style.display = 'block';
            var reqBox = document.getElementById('request-topic-box');
            if (reqBox) reqBox.style.display = 'block';
            var reqTitle = document.getElementById('request-topic-title');
            if (reqTitle) reqTitle.value = q;
            var loadMore = document.getElementById('load-more-container');
            if (loadMore) loadMore.style.display = 'none';
            return;
          }
          var reqBoxHide = document.getElementById('request-topic-box');
          if (reqBoxHide) reqBoxHide.style.display = 'none';

          // Store all results, show first INITIAL_DISPLAY
          window._searchResults = results;
          var visible = results.slice(0, INITIAL_DISPLAY);

          var container = document.getElementById('results-container');
          container.innerHTML = renderResultCards(visible, q);

          // Load more button
          var loadMoreEl = document.getElementById('load-more-container');
          var maxBanner = document.getElementById('max-results-banner');
          if (maxBanner) maxBanner.remove();

          if (loadMoreEl) {
            if (results.length > INITIAL_DISPLAY) {
              loadMoreEl.style.display = 'block';
              document.getElementById('load-more-btn').textContent = 'Show all ' + results.length + ' results';
            } else {
              loadMoreEl.style.display = 'none';
            }
          }
          if (hitMax && results.length <= INITIAL_DISPLAY) {
            showMaxBanner(container);
          }
        } else {
          var emptyFinal = document.getElementById('results-empty');
          if (emptyFinal) emptyFinal.style.display = 'block';
        }
      } catch (err) {
        console.error('[Search error]', err);
        document.getElementById('results-loading').style.display = 'none';
        document.getElementById('results-container').innerHTML = '<div class="alert alert-warning">Search failed: ' + escapeHtml(err.message || 'Unknown error') + '</div>';
      }
    }

    function truncate(str, len) {
      if (!str) return '';
      if (str.length <= len) return str;
      return str.substring(0, len) + '...';
    }

    function showSearchToast(type, message) {
      var existing = document.getElementById('search-toast');
      if (existing) existing.remove();
      var toast = document.createElement('div');
      toast.id = 'search-toast';
      toast.className = 'alert alert-' + type;
      toast.style.marginBottom = 'var(--space-md)';
      toast.textContent = message;
      document.getElementById('results-container').prepend(toast);
      setTimeout(function() { toast.remove(); }, 5000);
    }

    async function subscribeToSimilar(query) {
      if (!user) { showSearchToast('warning', 'Please log in first.'); return; }
      try {
        var { status, data } = await API.post('/subscriptions', {
          type: 'keyword',
          keyword: query,
          notificationMethod: 'polling',
        });
        if (status === 201) {
          showSearchToast('success', 'Subscribed! You will see matches in your Notifications.');
        } else if (data && data.error) {
          showSearchToast('warning', data.error.message || 'Subscription failed.');
        }
      } catch (err) {
        showSearchToast('warning', 'Failed to create subscription.');
      }
    }

    // Event delegation for dynamically generated subscribe buttons
    document.getElementById('results-container').addEventListener('click', function(e) {
      var btn = e.target.closest('.subscribe-similar-btn');
      if (btn) subscribeToSimilar(btn.dataset.query);
    });

    // Request-a-topic form
    document.getElementById('request-topic-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var title = document.getElementById('request-topic-title').value.trim();
      var feedback = document.getElementById('request-topic-feedback');
      if (!title || title.length < 3) {
        feedback.style.display = 'block';
        feedback.textContent = 'Title must be at least 3 characters.';
        feedback.style.color = 'var(--warning)';
        return;
      }
      try {
        var res = await API.post('/topic-requests', { title: title });
        if (res.status === 201) {
          feedback.style.display = 'block';
          feedback.textContent = 'Topic requested! Contributors will see it.';
          feedback.style.color = 'var(--success, #4a6e5a)';
          document.getElementById('request-topic-title').value = '';
        } else {
          var msg = (res.data && res.data.error) ? res.data.error.message : 'Failed to submit request.';
          feedback.style.display = 'block';
          feedback.textContent = msg;
          feedback.style.color = 'var(--warning)';
        }
      } catch (err) {
        feedback.style.display = 'block';
        feedback.textContent = 'Network error. Please try again.';
        feedback.style.color = 'var(--warning)';
      }
    });
