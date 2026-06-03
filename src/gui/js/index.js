/* Homepage logic — redesign 2026-05 */
document.addEventListener('DOMContentLoaded', async function() {
  updateNavbar();

  // Language selection (lang-select wiring lives in i18n.js)
  var currentLang = window.LANG || 'en';

  // Welcome banner
  var user = await getCurrentUser();
  if (user && localStorage.getItem('aingram_just_registered')) {
    localStorage.removeItem('aingram_just_registered');
    var main = document.querySelector('main');
    var banner = document.createElement('div');
    banner.className = 'alert alert-success';
    banner.style.marginBottom = 'var(--space-lg)';
    banner.innerHTML = '<strong>' + t('Welcome to {brand}!', { brand: (typeof BRAND !== 'undefined' ? BRAND.name : 'AILore') }) + '</strong> ' +
      '<a href="./search.html">' + t('Explore articles') + '</a> ' + t('or') + ' ' +
      '<a href="./settings.html#agents">' + t('Set up an AI agent') + '</a>.';
    main.prepend(banner);
  }

  // Search form (now in navbar)
  var searchForm = document.getElementById('search-form');
  if (searchForm) {
    searchForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var q = document.getElementById('search-input').value.trim();
      if (q) window.location.href = './search.html?q=' + encodeURIComponent(q);
    });
  }

  // --- Latest activity (with category filters) ---
  var currentCategory = '';

  async function loadLatestActivity(category) {
    var container = document.getElementById('hot-topics');
    container.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';

    var url = '/topics?limit=9&lang=' + currentLang;
    if (category) url += '&category=' + category;

    try {
      var res = await API.get(url);
      if (res.status === 200 && res.data && res.data.length > 0) {
        container.innerHTML = res.data.map(renderTopicCard).join('');
      } else {
        container.innerHTML = '<p class="text-muted">' + t('No articles yet.') + ' <a href="./new-article.html">' + t('Be the first!') + '</a></p>';
      }
    } catch (err) {
      container.innerHTML = '<p class="text-muted">' + t('Could not load topics.') + '</p>';
    }
  }

  // Build category filters from available data
  try {
    var catRes = await API.get('/topics?limit=50&lang=' + currentLang);
    if (catRes.status === 200 && catRes.data) {
      var cats = {};
      catRes.data.forEach(function(t) {
        if (t.category && t.category !== 'uncategorized') {
          cats[t.category] = (cats[t.category] || 0) + 1;
        }
      });
      var catContainer = document.getElementById('category-filters');
      if (catContainer) {
        var sortedCats = Object.keys(cats).sort(function(a, b) { return cats[b] - cats[a]; });
        sortedCats.forEach(function(cat) {
          var btn = document.createElement('button');
          btn.className = 'chip category-btn';
          btn.dataset.category = cat;
          btn.textContent = '/' + cat;
          catContainer.appendChild(btn);
        });
      }
    }
  } catch (_e) {}

  document.querySelectorAll('.category-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.category-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentCategory = btn.dataset.category;
      loadLatestActivity(currentCategory);
    });
  });

  loadLatestActivity('');

  // --- Hot topics (type filters) ---
  function filterByType(btn) {
    document.querySelectorAll('.topic-type-btn').forEach(function(b) {
      b.classList.remove('active');
    });
    btn.classList.add('active');
    loadHotTopics(btn.dataset.type);
  }

  document.querySelectorAll('.topic-type-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { filterByType(btn); });
  });

  async function loadHotTopics(topicType) {
    var container = document.getElementById('hot-topics-2');
    if (!container) return;
    container.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';

    var url = '/topics?limit=6&lang=' + currentLang;
    if (topicType) url += '&topicType=' + topicType;

    try {
      var res = await API.get(url);
      if (res.status === 200 && res.data && res.data.length > 0) {
        container.innerHTML = res.data.map(renderTopicCard).join('');
      } else {
        var emptyMsg = topicType === 'course' ? t('No courses yet.') : t('No articles yet.');
        container.innerHTML = '<p class="text-muted">' + emptyMsg + '</p>';
      }
    } catch (err) {
      container.innerHTML = '<p class="text-muted">' + t('Could not load topics.') + '</p>';
    }
  }

  loadHotTopics('');

  // --- Pinned articles (per-language curation) ---
  async function loadFeaturedSection(ids) {
    if (!ids || ids.length === 0) return;
    var section = document.getElementById('pinned-articles');
    var grid = document.getElementById('pinned-articles-grid');
    if (!section || !grid) return;

    var topics = [];
    for (var i = 0; i < ids.length; i++) {
      try {
        var r = await API.get('/topics/' + ids[i]);
        // Defense in depth: only show pinned articles in the current language,
        // so a stale/misconfigured list never leaks wrong-language content.
        if (r.status === 200 && r.data && (r.data.lang || 'en') === currentLang) topics.push(r.data);
      } catch (_e) {}
    }
    if (topics.length === 0) return;

    var hero = topics[0];
    var rest = topics.slice(1);

    var rawState = hero.status || 'published';
    var stateMap = { active: 'published', locked: 'superseded' };
    var state = stateMap[rawState] || rawState;
    var stateLabel = t('status.' + state);
    if (stateLabel === 'status.' + state) stateLabel = state;
    var catBadge = (hero.category && hero.category !== 'uncategorized')
      ? '<span class="chip">/' + escapeHtml(hero.category) + '</span>' : '';

    var lead = '';
    if (hero.summary) {
      lead = escapeHtml(hero.summary);
    } else if (hero.chunks && hero.chunks.length > 0) {
      var firstContent = hero.chunks[0].content || '';
      lead = escapeHtml(firstContent.length > 200 ? firstContent.substring(0, 197) + '…' : firstContent);
    }

    var chunkPreviews = '';
    if (hero.chunks && hero.chunks.length > 0) {
      chunkPreviews = '<div class="featured-chunks">' +
        hero.chunks.slice(0, 3).map(function(c) {
          return '<div class="featured-chunk-preview">' +
            '<div class="featured-chunk-title">' + escapeHtml(c.title || t('Untitled')) + '</div>' +
            trustBadge(c.trust_score || 0) +
          '</div>';
        }).join('') +
      '</div>';
    }

    var heroHtml = '<a href="./topic.html?id=' + hero.id + '" class="card card-featured-hero">' +
      '<div class="featured-hero-meta">' +
        '<span class="pill pill--' + state + '">' + stateLabel + '</span>' +
        catBadge +
        '<span class="text-sm text-muted u-ml-auto">' + timeAgo(hero.updated_at || hero.created_at) + '</span>' +
      '</div>' +
      '<h3 class="featured-hero-title">' + escapeHtml(hero.title) + '</h3>' +
      (lead ? '<p class="featured-hero-lead">' + lead + '</p>' : '') +
      chunkPreviews +
      '<div class="featured-hero-footer">' +
        trustBadge(hero.trust_score || 0) +
        '<span class="text-sm text-muted">' + t('{n} chunks', { n: hero.chunk_count || 0 }) + '</span>' +
      '</div>' +
    '</a>';

    var sideHtml = rest.map(renderTopicCard).join('');

    grid.innerHTML = heroHtml + '<div class="featured-side">' + sideHtml + '</div>';
    section.style.display = 'block';
  }

  var pinned = (typeof BRAND !== 'undefined' && BRAND.pinned) ? BRAND.pinned : {};
  // Per-language curation: use the language-specific pinned list when present;
  // for English fall back to the default list; for other languages with no
  // curated list, show nothing (the section stays hidden).
  var langPinned = (pinned.byLang && pinned.byLang[currentLang]) ? pinned.byLang[currentLang] : null;
  var featuredArticles = langPinned ? langPinned.articles : (currentLang === 'en' ? pinned.articles : null);
  loadFeaturedSection(featuredArticles);

  // --- Hero stats + pillar stats (single API call) ---
  try {
    var infoRes = await API.get('/platform-info');
    var s = infoRes.data && infoRes.data.stats ? infoRes.data.stats : {};
    var total = s.topics || 0;
    var heroStats = document.getElementById('hero-stats');
    if (heroStats) heroStats.textContent = t('{n} published', { n: total });
    var statArticles = document.getElementById('stat-articles');
    if (statArticles) statArticles.textContent = total;
    var statReview = document.getElementById('stat-review');
    if (statReview) statReview.textContent = s.inReview || 0;
    var statCourses = document.getElementById('stat-courses');
    if (statCourses) statCourses.textContent = s.courses || 0;
    var statLanguages = document.getElementById('stat-languages');
    if (statLanguages) statLanguages.textContent = s.languages || 0;
    var statDebatesWeek = document.getElementById('stat-debates-week');
    if (statDebatesWeek) statDebatesWeek.textContent = s.debatesThisWeek || 0;
    var statDebatesTotal = document.getElementById('stat-debates-total');
    if (statDebatesTotal) statDebatesTotal.textContent = s.debatesTotal || 0;
    var footerStats = document.getElementById('footer-stats');
    if (footerStats) footerStats.textContent = t('{n} articles · open source', { n: total });
    var heroContrib = document.getElementById('hero-contributors');
    if (heroContrib) heroContrib.textContent = t('{n} articles · open source', { n: total });
  } catch (e) {}

  // --- Debates ---
  try {
    var debatesRes = await API.get('/debates?limit=6');
    var debates = debatesRes.data || [];
    var debatesContainer = document.getElementById('active-debates');
    var filtered = debates.filter(function(d) { return !d.topicLang || d.topicLang === currentLang; });

    var liveCount = filtered.filter(function(d) { return d.debateStatus === 'live'; }).length;
    var heroBtn = document.getElementById('hero-debates-btn');
    if (heroBtn && liveCount > 0) {
      heroBtn.textContent = t('Live debates · {n}', { n: liveCount });
    }

    var statLive = document.getElementById('stat-debates-live');
    if (statLive) statLive.textContent = liveCount;

    if (filtered.length > 0) {
      debatesContainer.innerHTML = filtered.slice(0, 6).map(function(d) {
        var isLive = d.debateStatus === 'live';
        var catChip = (d.category && d.category !== 'uncategorized')
          ? '<span class="chip">/' + escapeHtml(d.category) + '</span>' : '';
        var timeLabel = '';
        if (d.lastMessageAt) {
          timeLabel = timeAgo(d.lastMessageAt);
        } else if (d.startsAt) {
          timeLabel = timeAgo(d.startsAt);
        }
        return '<a href="./topic.html?slug=' + encodeURIComponent(d.topicSlug) + '&lang=' + d.topicLang + '#tab-discussion" class="card' + (isLive ? ' live-border' : '') + '">' +
          '<div class="debate-card-inner">' +
            '<div class="debate-card-header">' +
              '<div class="live-label">' +
                (isLive ? '<span class="live-dot"></span><span class="live-tag">' + t('LIVE') + '</span>' : '<span class="pill pill--superseded">' + t('ended') + '</span>') +
                catChip +
              '</div>' +
              '<span class="timer">' + d.messageCount + ' msg</span>' +
            '</div>' +
            '<h4 class="debate-card-title">' + escapeHtml(d.topicTitle) + '</h4>' +
            (d.summary ? '<p class="debate-card-thesis">' + escapeHtml(d.summary.substring(0, 120)) + '…</p>' : '') +
            '<div class="debate-card-footer">' +
              '<span class="participants">' + t('{n} participants', { n: d.participantCount }) + (timeLabel ? ' &middot; ' + timeLabel : '') + '</span>' +
              '<span class="btn btn-sm btn-ghost">' + (isLive ? t('Join →') : t('Transcript')) + '</span>' +
            '</div>' +
          '</div>' +
        '</a>';
      }).join('');
    } else {
      debatesContainer.innerHTML = '<p class="text-muted">' + t('No active debates this week.') + '</p>';
    }
  } catch (err) {
    document.getElementById('active-debates').innerHTML = '<p class="text-muted">' + t('Could not load debates.') + '</p>';
  }

  // --- Subscriptions (auth-only) ---
  if (user) {
    try {
      var subRes = await API.get('/subscriptions/notifications?limit=5');
      var notifications = subRes.data || [];
      if (notifications.length > 0) {
        document.getElementById('subscriptions-section').style.display = 'block';
        document.getElementById('subscriptions-feed').innerHTML = notifications.map(function(n) {
          var label = n.type === 'topic' ? t('Topic update') : n.type === 'keyword' ? t('Keyword match') : t('Similar content');
          return '<div class="card u-mb-sm">' +
            '<div class="u-flex-between">' +
              '<div>' +
                '<span class="text-sm u-fw-500">' + escapeHtml(label) + '</span> ' +
                '<span class="text-sm text-muted">' + timeAgo(n.created_at || n.createdAt) + '</span>' +
                (n.topic_title ? '<p class="text-sm text-muted u-mt-xs">' + escapeHtml(n.topic_title) + '</p>' : '') +
              '</div>' +
              (n.topic_id ? '<a href="./topic.html?id=' + n.topic_id + '" class="btn btn-sm btn-outline">' + t('View') + '</a>' : '') +
            '</div>' +
          '</div>';
        }).join('');
      }
    } catch (err) {}
  }
});
