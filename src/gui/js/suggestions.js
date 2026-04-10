/* Extracted from src/gui/suggestions.html during CSP S6 migration. */
let currentPage = 1;

    function toggleForm() {
      const form = document.getElementById('suggestion-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    }

    function categoryBadge(cat) {
      const colors = {
        governance: '#6366f1', ui_ux: '#ec4899', technical: '#14b8a6',
        new_feature: '#f59e0b', documentation: '#8b5cf6', other: '#6b7280'
      };
      const labels = {
        governance: 'Governance', ui_ux: 'UI/UX', technical: 'Technical',
        new_feature: 'New Feature', documentation: 'Documentation', other: 'Other'
      };
      const c = colors[cat] || '#6b7280';
      return '<span class="s-dcf9ee87">' + (labels[cat] || cat) + '</span>';
    }

    function statusBadge(status) {
      if (status === 'published') return '<span class="badge badge-success" title="Community-approved recommendation. Implementation at maintainer discretion.">Approved</span>';
      if (status === 'under_review') return '<span class="badge badge-warning">Under Review</span>';
      if (status === 'retracted') return '<span class="badge badge-danger">Retracted</span>';
      return '<span class="badge">' + status + '</span>';
    }

    async function loadSuggestions(append) {
      if (!append) currentPage = 1;
      const status = document.getElementById('filter-status').value;
      const category = document.getElementById('filter-category').value;
      const params = new URLSearchParams({ status, page: currentPage, limit: 20 });
      if (category) params.set('category', category);

      try {
        const res = await API.get('/v1/suggestions?' + params);
        const items = res.data || [];
        const total = res.pagination ? res.pagination.total : items.length;

        document.getElementById('suggestion-count').textContent = total + ' suggestion(s)';

        const container = document.getElementById('suggestions-list');
        if (!append) container.innerHTML = '';

        if (items.length === 0 && !append) {
          container.innerHTML = '<p class="text-muted">No suggestions found.</p>';
        }

        for (const s of items) {
          const card = document.createElement('div');
          card.className = 'card';
          card.style.marginBottom = 'var(--space-md)';
          card.style.padding = 'var(--space-lg)';
          card.innerHTML = [
            '<div class="s-71f86edc">',
            '  <div>',
            '    <h3 class="s-8ed36b6e">' + escapeHtml(s.title || s.content.substring(0, 80) + '...') + '</h3>',
            '    <div class="s-be1d6f45">',
            '      ' + categoryBadge(s.suggestion_category),
            '      ' + statusBadge(s.status),
            '      <span class="text-sm text-muted">by ' + escapeHtml(s.author_name || 'Unknown') + '</span>',
            '      <span class="text-sm text-muted">' + new Date(s.created_at).toLocaleDateString() + '</span>',
            '    </div>',
            '  </div>',
            '</div>',
            '<p class="s-05460b51">' + escapeHtml(s.content.substring(0, 300)) + (s.content.length > 300 ? '...' : '') + '</p>',
            s.rationale ? '<p class="text-sm text-muted s-c15f7cfa"><strong>Rationale:</strong> ' + escapeHtml(s.rationale.substring(0, 200)) + '</p>' : '',
            '<div class="s-05460b51">',
            '  <a href="./topic.html?slug=' + (s.topic_slug || '') + '" class="text-sm">View topic</a>',
            '</div>',
          ].join('\n');
          container.appendChild(card);
        }

        const loadMoreContainer = document.getElementById('load-more-container');
        loadMoreContainer.style.display = (currentPage * 20 < total) ? 'block' : 'none';

        document.getElementById('suggestions-loading').style.display = 'none';
        document.getElementById('suggestions-content').style.display = 'block';
      } catch (err) {
        document.getElementById('suggestions-loading').style.display = 'none';
        document.getElementById('suggestions-error').style.display = 'block';
        document.getElementById('suggestions-error').innerHTML = '<p class="text-muted">Failed to load suggestions.</p>';
      }
    }

    function loadMore() {
      currentPage++;
      loadSuggestions(true);
    }

    async function loadTopics() {
      try {
        const res = await API.get('/v1/topics?limit=100');
        const select = document.getElementById('sug-topic');
        select.innerHTML = '<option value="">Select topic...</option>';
        for (const t of (res.data || [])) {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.title;
          select.appendChild(opt);
        }
      } catch (err) {
        console.error('Failed to load topics:', err);
      }
    }

    async function submitSuggestion() {
      const errEl = document.getElementById('form-error');
      errEl.style.display = 'none';

      const body = {
        title: document.getElementById('sug-title').value.trim(),
        content: document.getElementById('sug-content').value.trim(),
        suggestionCategory: document.getElementById('sug-category').value,
        topicId: document.getElementById('sug-topic').value,
        rationale: document.getElementById('sug-rationale').value.trim() || undefined,
      };

      if (!body.content || body.content.length < 20) {
        errEl.textContent = 'Proposal must be at least 20 characters.';
        errEl.style.display = 'block';
        return;
      }
      if (!body.suggestionCategory) {
        errEl.textContent = 'Please select a category.';
        errEl.style.display = 'block';
        return;
      }
      if (!body.topicId) {
        errEl.textContent = 'Please select a topic.';
        errEl.style.display = 'block';
        return;
      }

      try {
        const res = await API.post('/v1/suggestions', body);
        if (res.status >= 400) {
          throw new Error(res.error?.message || 'Failed to submit');
        }
        toggleForm();
        document.getElementById('sug-title').value = '';
        document.getElementById('sug-content').value = '';
        document.getElementById('sug-rationale').value = '';
        loadSuggestions();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    }

    // Init
    updateNavbar();
    loadSuggestions();
    loadTopics();

    // Event listeners (migrated from inline onclick)
    document.getElementById('toggle-form-btn').addEventListener('click', toggleForm);
    document.getElementById('submit-suggestion-btn').addEventListener('click', submitSuggestion);
    document.getElementById('cancel-suggestion-btn').addEventListener('click', toggleForm);
    document.getElementById('load-more-btn').addEventListener('click', loadMore);
    document.getElementById('filter-status').addEventListener('change', function() { loadSuggestions(); });
    document.getElementById('filter-category').addEventListener('change', function() { loadSuggestions(); });
