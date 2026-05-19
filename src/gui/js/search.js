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
    } catch (e) {}
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
      '<div class="featured-course-meta"><span>' + chapCount + ' chapter' + (chapCount !== 1 ? 's' : '') + '</span></div>' +
    '</a>';
  }).join('');
  section.style.display = 'block';
}

document.addEventListener('DOMContentLoaded', function() {
  updateNavbar();

  var topicTypeParam = getParam('topicType');
  var titleEl = document.getElementById('search-page-title');

  var featuredSection = document.getElementById('featured-courses');
  if (topicTypeParam === 'course') {
    if (titleEl) titleEl.textContent = 'Courses';
    document.getElementById('filter-topic-type').value = 'course';
    setActiveChip('course');
    loadFeaturedCourses();
  } else {
    if (!topicTypeParam) document.getElementById('filter-topic-type').value = 'knowledge';
    setActiveChip('');
    if (featuredSection) featuredSection.style.display = 'none';
  }

  // Populate category filter dynamically
  loadCategoryOptions();

  var q = getParam('q') || '';
  if (q) {
    document.getElementById('search-input').value = q;
    if (titleEl) titleEl.textContent = 'Search';
    doSearch(q);
  } else {
    loadRecentTopics();
  }

  document.getElementById('search-form').addEventListener('submit', function(e) {
    e.preventDefault();
    var q = document.getElementById('search-input').value.trim();
    if (q) {
      history.pushState(null, '', './search.html?q=' + encodeURIComponent(q));
      if (titleEl) titleEl.textContent = 'Search';
      doSearch(q);
    }
  });

  // Chip type filters
  document.querySelectorAll('.chip-filter').forEach(function(chip) {
    chip.addEventListener('click', function() {
      setActiveChip(chip.dataset.type);
      document.getElementById('filter-topic-type').value = chip.dataset.type;
      if (titleEl) {
        if (chip.dataset.type === 'course') titleEl.textContent = 'Courses';
        else titleEl.textContent = 'Articles';
      }
      if (featuredSection) {
        if (chip.dataset.type === 'course') { loadFeaturedCourses(); }
        else { featuredSection.style.display = 'none'; }
      }
      var q = document.getElementById('search-input').value.trim();
      if (q) doSearch(q);
      else loadRecentTopics();
    });
  });

  ['filter-type', 'filter-lang', 'filter-category'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', function() {
      var q = document.getElementById('search-input').value.trim();
      if (q) doSearch(q);
      else loadRecentTopics();
    });
  });

  document.getElementById('load-more-btn').addEventListener('click', function() {
    if (!window._searchResults) return;
    var container = document.getElementById('results-container');
    container.className = 'search-results-list mt-md';
    container.innerHTML = renderResultCards(window._searchResults, currentQuery);
    this.parentElement.style.display = 'none';
    if (window._searchResults.length >= 50) showMaxBanner(container);
  });
});

function setActiveChip(type) {
  document.querySelectorAll('.chip-filter').forEach(function(c) {
    c.classList.toggle('active', c.dataset.type === type);
  });
}

async function loadCategoryOptions() {
  try {
    var res = await API.get('/topics?limit=50&lang=en');
    if (res.status !== 200 || !res.data) return;
    var cats = {};
    res.data.forEach(function(t) {
      if (t.category && t.category !== 'uncategorized') cats[t.category] = (cats[t.category] || 0) + 1;
    });
    var sel = document.getElementById('filter-category');
    Object.keys(cats).sort(function(a, b) { return cats[b] - cats[a]; }).forEach(function(cat) {
      var opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat.replace(/-/g, ' ');
      sel.appendChild(opt);
    });
  } catch (_e) {}
}

var user = null;
getCurrentUser().then(function(u) { user = u; });

function renderResultCards(items, q) {
  return items.map(function(item) {
    var topicLink = item.topic_id ? './topic.html?id=' + item.topic_id : '#';
    var topicTitle = item.topic_title || 'Unknown topic';
    var topicLang = (item.topic_lang || 'en').toUpperCase();
    var catBadge = (item.topic_category && item.topic_category !== 'uncategorized')
      ? '<span class="chip">/' + escapeHtml(item.topic_category) + '</span>' : '';
    return '<a href="' + topicLink + '" class="card search-result-card">' +
      '<div class="search-result-header">' +
        '<span class="search-result-title">' + escapeHtml(topicTitle) + '</span>' +
        trustBadge(item.trust_score || 0) +
      '</div>' +
      '<p class="search-result-snippet">' + escapeHtml(truncate(item.content_preview || item.content || '', 180)) + '</p>' +
      '<div class="search-result-meta">' +
        '<span class="chip chip--lang">' + escapeHtml(topicLang) + '</span>' +
        catBadge +
        '<span class="text-sm text-muted">' + timeAgo(item.updated_at || item.created_at) + '</span>' +
      '</div>' +
    '</a>';
  }).join('');
}

function showMaxBanner(container) {
  var banner = document.createElement('div');
  banner.id = 'max-results-banner';
  banner.className = 'alert alert-info mt-lg';
  banner.textContent = 'Maximum of 50 results reached. Refine your search for more specific results.';
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
  container.className = 'search-results-grid mt-md';
  container.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';

  var infoEl = document.getElementById('results-info');
  var loadMoreEl = document.getElementById('load-more-container');
  if (loadMoreEl) loadMoreEl.style.display = 'none';

  try {
    var res = await API.get(url);
    if (res.status === 200 && res.data && res.data.length > 0) {
      var label = topicType === 'course' ? 'courses' : 'articles';
      if (infoEl) {
        infoEl.style.display = 'block';
        infoEl.textContent = res.data.length + ' recent ' + label;
      }
      container.innerHTML = res.data.map(renderTopicCard).join('');
    } else {
      var emptyLabel = topicType === 'course' ? 'courses' : 'articles';
      if (infoEl) infoEl.style.display = 'none';
      container.innerHTML = '<p class="text-muted">No ' + emptyLabel + ' yet.</p>';
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
  container.className = 'search-results-list mt-md';
  container.innerHTML = '<p class="text-muted"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Searching…</p>';
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
    if (res.status === 200 && res.data) {
      var results = res.data;
      var hitMax = results.length >= SEARCH_MAX;

      var infoEl = document.getElementById('results-info');
      if (infoEl) {
        infoEl.style.display = 'block';
        infoEl.textContent = hitMax
          ? 'Too many results — showing top ' + SEARCH_MAX
          : results.length + ' result' + (results.length !== 1 ? 's' : '');
      }

      if (results.length === 0) {
        container.innerHTML = '<p class="text-muted">No results found.</p>';
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

      window._searchResults = results;
      var visible = results.slice(0, INITIAL_DISPLAY);
      container.innerHTML = renderResultCards(visible, q);

      var loadMoreEl = document.getElementById('load-more-container');
      if (loadMoreEl) {
        if (results.length > INITIAL_DISPLAY) {
          loadMoreEl.style.display = 'block';
          document.getElementById('load-more-btn').textContent = 'Show all ' + results.length + ' results';
        } else {
          loadMoreEl.style.display = 'none';
        }
      }
      if (hitMax && results.length <= INITIAL_DISPLAY) showMaxBanner(container);
    } else {
      container.innerHTML = '<p class="text-muted">No results found.</p>';
    }
  } catch (err) {
    container.innerHTML = '<div class="alert alert-warning">Search failed: ' + escapeHtml(err.message || 'Unknown error') + '</div>';
  }
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len) + '…';
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
    var r = await API.post('/subscriptions', { type: 'keyword', keyword: query, notificationMethod: 'polling' });
    if (r.status === 201) {
      showSearchToast('success', 'Subscribed! You will see matches in your Notifications.');
    } else if (r.data && r.data.error) {
      showSearchToast('warning', r.data.error.message || 'Subscription failed.');
    }
  } catch (err) {
    showSearchToast('warning', 'Failed to create subscription.');
  }
}

document.getElementById('results-container').addEventListener('click', function(e) {
  var btn = e.target.closest('.subscribe-similar-btn');
  if (btn) subscribeToSimilar(btn.dataset.query);
});

document.getElementById('request-topic-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  var title = document.getElementById('request-topic-title').value.trim();
  var feedback = document.getElementById('request-topic-feedback');
  if (!title || title.length < 3) {
    feedback.style.display = 'block';
    feedback.textContent = 'Title must be at least 3 characters.';
    feedback.style.color = 'var(--trust-low)';
    return;
  }
  try {
    var res = await API.post('/topic-requests', { title: title });
    if (res.status === 201) {
      feedback.style.display = 'block';
      feedback.textContent = 'Topic requested! Contributors will see it.';
      feedback.style.color = 'var(--trust-high)';
      document.getElementById('request-topic-title').value = '';
    } else {
      var msg = (res.data && res.data.error) ? res.data.error.message : 'Failed to submit request.';
      feedback.style.display = 'block';
      feedback.textContent = msg;
      feedback.style.color = 'var(--trust-low)';
    }
  } catch (err) {
    feedback.style.display = 'block';
    feedback.textContent = 'Network error. Please try again.';
    feedback.style.color = 'var(--trust-low)';
  }
});
