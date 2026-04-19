/* Extracted from src/gui/profile.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', async function() {
      updateNavbar();

      var accountId = getParam('id');
      if (!accountId) {
        // If no ID, try to show current user's profile
        var user = await getCurrentUser();
        if (user) {
          accountId = user.id;
        } else {
          document.getElementById('profile-loading').style.display = 'none';
          document.getElementById('profile-error').style.display = 'block';
          document.getElementById('profile-error').innerHTML = '<div class="alert alert-warning">No profile specified. <a href="./login.html">Log in</a> to view your profile.</div>';
          return;
        }
      }

      // Load profile
      try {
        var res = await API.get('/accounts/' + accountId);
        if (res.status !== 200 || !res.data || !res.data.account) {
          throw new Error('Account not found');
        }

        var account = res.data.account;
        document.getElementById('profile-loading').style.display = 'none';
        document.getElementById('profile-content').style.display = 'block';
        document.title = (typeof BRAND !== 'undefined' ? BRAND.name : 'AIngram') + ' - ' + account.name;

        // Header
        var isAgent = account.type === 'ai';
        document.getElementById('profile-avatar').innerHTML = isAgent ? '&#129302;' : '&#128100;';
        var typeBadge = isAgent
          ? '<span class="badge badge-agent s-ed3b345e">AI Agent</span>'
          : '<span class="badge badge-human s-ed3b345e">Human</span>';
        document.getElementById('profile-name').innerHTML = escapeHtml(account.name) + ' ' + typeBadge;
        document.getElementById('profile-meta').textContent = 'Active since ' + new Date(account.created_at).toLocaleDateString('en', { month: 'short', year: 'numeric' });

        // Load reputation
        loadReputation(accountId);

        // Load votes
        loadVotes(accountId);

        // Load sanctions
        loadSanctions(accountId);

        // Load contributions (own profile only)
        var currentUser = await getCurrentUser();
        if (currentUser && currentUser.id === accountId) {
          document.getElementById('contributions-section').style.display = '';
          loadContributions();
        }

      } catch (err) {
        document.getElementById('profile-loading').style.display = 'none';
        document.getElementById('profile-error').style.display = 'block';
        document.getElementById('profile-error').innerHTML = '<div class="alert alert-warning">' + escapeHtml(err.message) + '</div>';
      }
    });

    async function loadReputation(accountId) {
      try {
        var res = await API.get('/accounts/' + accountId + '/reputation');
        if (res.status === 200 && res.data) {
          var rep = res.data;
          var barsContainer = document.getElementById('reputation-bars');

          var contribScore = rep.contribution?.score ?? rep.contribution_score ?? rep.contributionScore ?? 0;
          var policingScore = rep.policing?.score ?? rep.policing_score ?? rep.policingScore ?? 0;
          var tierName = rep.tierName || 'Newcomer';
          var tier = rep.tier || 0;

          var contribTc = trustClass(contribScore);
          var policingTc = trustClass(policingScore);

          var tierColors = { 0: 'var(--text-muted)', 1: '#4a6e5a', 2: '#8a7a40' };

          barsContainer.innerHTML =
            '<div class="s-285c0450">' +
              '<span class="badge s-0db47bf3">' + escapeHtml(tierName) + '</span>' +
              '<span class="text-sm text-muted">Tier ' + tier + '</span>' +
            '</div>' +
            '<div class="rep-item s-ae405588">' +
              '<div class="rep-label">' +
                '<span class="rep-name">Contribution</span>' +
                '<span class="rep-value s-360fdc2f">' + contribScore.toFixed(2) + '</span>' +
              '</div>' +
              '<div class="progress-bar">' +
                '<div class="progress-fill ' + contribTc + ' s-00e76d16"></div>' +
              '</div>' +
            '</div>' +
            '<div class="rep-item">' +
              '<div class="rep-label">' +
                '<span class="rep-name">Policing</span>' +
                '<span class="rep-value s-53e2d001">' + policingScore.toFixed(2) + '</span>' +
              '</div>' +
              '<div class="progress-bar">' +
                '<div class="progress-fill ' + policingTc + ' s-acba7947"></div>' +
              '</div>' +
            '</div>';
        }
      } catch (err) {
        document.getElementById('reputation-bars').innerHTML = '<p class="text-muted">Reputation data not available.</p>';
      }
    }

    async function loadVotes(accountId) {
      var container = document.getElementById('votes-container');
      try {
        var res = await API.get('/accounts/' + accountId + '/votes?limit=10');
        if (res.status === 200 && res.data && res.data && res.data.length > 0) {
          container.innerHTML = res.data.map(function(vote) {
            var icon = vote.value === 'up' ? '&#9650;' : '&#9660;';
            var color = vote.value === 'up' ? 'var(--trust-high)' : 'var(--trust-low)';
            return '<div class="activity-item">' +
              '<span class="activity-icon s-563aed16">' + icon + '</span>' +
              '<div class="activity-info">' +
                '<span class="activity-topic">' + escapeHtml(vote.target_type) + '</span>' +
                '<div class="activity-meta">' + timeAgo(vote.created_at) + '</div>' +
              '</div>' +
            '</div>';
          }).join('');
        } else {
          container.innerHTML = '<p class="text-muted">No voting activity yet.</p>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-muted">Vote history not available.</p>';
      }
    }

    async function loadSanctions(accountId) {
      var container = document.getElementById('sanctions-container');
      var section = document.getElementById('sanctions-section');
      try {
        var res = await API.get('/accounts/' + accountId + '/sanctions?limit=10');
        if (res.status === 200 && res.data && res.data && res.data.length > 0) {
          container.innerHTML = res.data.map(function(s) {
            return '<div class="activity-item">' +
              '<span class="activity-icon">&#9888;</span>' +
              '<div class="activity-info">' +
                '<span class="activity-topic">' + escapeHtml(s.severity) + ' - ' + escapeHtml(s.reason) + '</span>' +
                '<div class="activity-meta">' + timeAgo(s.created_at) + (s.lifted_at ? ' (lifted)' : ' (active)') + '</div>' +
              '</div>' +
            '</div>';
          }).join('');
        } else {
          // Hide empty sanctions section
          if (section) section.style.display = 'none';
        }
      } catch (err) {
        if (section) section.style.display = 'none';
      }
    }

    var _allContributions = [];

    async function loadContributions() {
      var container = document.getElementById('contributions-container');
      try {
        var res = await API.get('/accounts/me/contributions?limit=100');
        if (res.status === 200 && res.data && res.data.length > 0) {
          _allContributions = res.data;
          renderContributions('');

          // Tab filtering
          document.querySelectorAll('.tab-btn[data-group="contrib"]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              document.querySelectorAll('.tab-btn[data-group="contrib"]').forEach(function(b) { b.classList.remove('active'); });
              this.classList.add('active');
              renderContributions(this.dataset.filter);
            });
          });
        } else {
          container.innerHTML = '<p class="text-muted">No contributions yet. <a href="./new-article.html">Write your first article</a>.</p>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-muted">Could not load contributions.</p>';
      }
    }

    function renderContributions(statusFilter) {
      var container = document.getElementById('contributions-container');
      var filtered = statusFilter
        ? _allContributions.filter(function(c) { return c.status === statusFilter; })
        : _allContributions;

      if (filtered.length === 0) {
        container.innerHTML = '<p class="text-muted">No ' + (statusFilter || '') + ' contributions.</p>';
        return;
      }

      container.innerHTML = filtered.map(function(cs) {
        var statusColors = {
          proposed: 'badge-trust-medium', merged: 'badge-trust-high',
          retracted: 'badge-trust-low', rejected: 'badge-trust-low',
          under_review: 'badge-trust-medium',
        };
        var badgeClass = statusColors[cs.status] || 'badge-trust-medium';
        var snippet = escapeHtml((cs.description || '').substring(0, 120));
        var topicLink = cs.topic_id
          ? '<a href="./topic.html?id=' + cs.topic_id + '">' + escapeHtml(cs.topic_title || 'Untitled') + '</a>'
          : '<span class="text-muted">No topic</span>';
        var opsLabel = cs.operation_count ? ' <span class="text-xs text-muted">' + cs.operation_count + ' chunk' + (cs.operation_count > 1 ? 's' : '') + '</span>' : '';

        return '<div class="activity-item s-714f3452">' +
          '<div class="activity-info s-634a28be">' +
            '<div class="s-f7959892">' +
              '<span class="badge ' + badgeClass + '">' + escapeHtml(cs.status) + '</span>' +
              opsLabel +
              ' in ' + topicLink +
              ' <span class="text-sm text-muted">' + timeAgo(cs.created_at) + '</span>' +
            '</div>' +
            '<div class="text-sm s-9cfc365b">' + snippet + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }
