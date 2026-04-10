/* Extracted from src/gui/hot-topics.html during CSP S6 migration. */
(async function() {
      updateNavbar();

      const loading = document.getElementById('hot-loading');
      const error = document.getElementById('hot-error');
      const empty = document.getElementById('hot-empty');
      const table = document.getElementById('hot-table');
      const tbody = document.getElementById('hot-body');

      try {
        const { status, data } = await API.get('/v1/analytics/hot-topics');
        loading.style.display = 'none';

        if (status !== 200 || !data || !data.data || data.data.length === 0) {
          empty.style.display = '';
          return;
        }

        data.data.forEach((topic, i) => {
          const tr = document.createElement('tr');
          const ago = timeAgo(topic.last_activity);
          tr.innerHTML = `
            <td class="text-muted">${i + 1}</td>
            <td><a href="./topic.html?slug=${encodeURIComponent(topic.slug)}">${escapeHtml(topic.title)}</a></td>
            <td class="s-30489cbd"><strong>${topic.activity_count}</strong></td>
            <td class="text-muted text-sm s-30489cbd">${ago}</td>
          `;
          tbody.appendChild(tr);
        });

        table.style.display = '';
      } catch (err) {
        loading.style.display = 'none';
        error.style.display = '';
        error.innerHTML = '<p class="text-danger">Failed to load hot topics. Please try again later.</p>';
      }
    })();
