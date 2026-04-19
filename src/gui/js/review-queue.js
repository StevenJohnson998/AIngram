/* Extracted from src/gui/review-queue.html during CSP S6 migration. */
var currentPage = 1;
    var rejectingChangesetId = null;

    document.addEventListener('DOMContentLoaded', async function() {
      updateNavbar();

      var user = await getCurrentUser();
      if (!user) {
        document.getElementById('review-loading').style.display = 'none';
        document.getElementById('review-error').style.display = 'block';
        document.getElementById('review-error').innerHTML = '<div class="alert alert-warning">You must be <a href="./login.html">logged in</a> with review permissions to access the review queue.</div>';
        return;
      }

      document.getElementById('review-loading').style.display = 'none';
      document.getElementById('review-content').style.display = 'block';

      loadFlags('open', 1);
      loadProposals();

      document.getElementById('filter-status').addEventListener('change', function() {
        loadFlags(this.value, 1);
      });

      document.getElementById('load-more-btn').addEventListener('click', function() {
        var status = document.getElementById('filter-status').value;
        loadFlags(status, currentPage + 1, true);
      });

      // Reject modal handlers
      document.getElementById('reject-cancel').addEventListener('click', closeRejectModal);
      document.getElementById('reject-confirm').addEventListener('click', confirmReject);
      document.getElementById('reject-modal').addEventListener('click', function(e) {
        if (e.target === this) closeRejectModal();
      });
    });

    // --- Flags ---

    async function loadFlags(status, page, append) {
      currentPage = page;

      try {
        var res = await API.get('/flags?status=' + status + '&page=' + page + '&limit=20');

        if (res.status === 403) {
          document.getElementById('flags-container').innerHTML = '<div class="alert alert-warning">Review access requires building up your reputation first. Keep contributing to earn it!</div>';
          return;
        }

        if (res.status === 200 && res.data && res.data) {
          var flags = res.data;
          var total = res.pagination ? res.pagination.total : flags.length;
          document.getElementById('flag-count').textContent = total + ' flag' + (total !== 1 ? 's' : '') + ' ' + status;

          if (flags.length === 0 && !append) {
            document.getElementById('flags-container').innerHTML = '<p class="text-muted">No flags with status "' + status + '".</p>';
            document.getElementById('load-more-container').style.display = 'none';
            return;
          }

          var html = flags.map(function(flag) {
            var tc = 'trust-medium';
            var targetLink = '';
            if (flag.target_type === 'topic' && flag.target_id) {
              targetLink = '<a href="./topic.html?id=' + encodeURIComponent(flag.target_id) + '">View topic</a>';
            } else if (flag.target_type === 'chunk' && flag.target_id) {
              targetLink = '<span>Chunk ' + escapeHtml(flag.target_id.substring(0, 8)) + '</span>';
            }
            return '<div class="review-item">' +
              '<div class="review-bar ' + tc + '"></div>' +
              '<div class="review-body">' +
                '<div class="review-content">' + escapeHtml(flag.reason) + '</div>' +
                '<div class="review-meta">' +
                  '<span>Target: ' + escapeHtml(flag.target_type) + '</span>' +
                  (targetLink ? '<span class="sep">&middot;</span>' + targetLink : '') +
                  '<span class="sep">&middot;</span>' +
                  '<span>Status: ' + escapeHtml(flag.status) + '</span>' +
                  '<span class="sep">&middot;</span>' +
                  '<span>' + timeAgo(flag.created_at) + '</span>' +
                '</div>' +
                '<div class="review-tags">' +
                  '<span class="badge badge-trust-medium">' + escapeHtml(flag.status) + '</span>' +
                '</div>' +
              '</div>' +
              '<div class="review-actions">' +
                (flag.status === 'open' ? '<button class="btn btn-secondary btn-sm flag-review-btn" data-id="' + flag.id + '">Review</button>' : '') +
                (flag.status === 'open' || flag.status === 'reviewing' ? '<button class="btn btn-secondary btn-sm flag-dismiss-btn" data-id="' + flag.id + '">Dismiss</button>' : '') +
                (flag.status === 'open' || flag.status === 'reviewing' ? '<button class="btn btn-danger btn-sm flag-action-btn" data-id="' + flag.id + '">Action</button>' : '') +
              '</div>' +
            '</div>';
          }).join('');

          var container = document.getElementById('flags-container');
          if (append) {
            container.innerHTML += html;
          } else {
            container.innerHTML = html;
          }

          container.querySelectorAll('.flag-review-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { flagAction(this.dataset.id, 'review'); });
          });
          container.querySelectorAll('.flag-dismiss-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { flagAction(this.dataset.id, 'dismiss'); });
          });
          container.querySelectorAll('.flag-action-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { flagAction(this.dataset.id, 'action'); });
          });

          var totalLoaded = page * 20;
          document.getElementById('load-more-container').style.display = totalLoaded < total ? 'block' : 'none';
        }
      } catch (err) {
        document.getElementById('flags-container').innerHTML = '<div class="alert alert-warning">Failed to load flags.</div>';
      }
    }

    async function flagAction(flagId, action) {
      try {
        var res = await API.put('/flags/' + flagId + '/' + action);
        if (res.status === 200) {
          var status = document.getElementById('filter-status').value;
          loadFlags(status, 1);
        } else {
          var msg = (res.data && res.data.error) ? res.data.error.message : 'Action failed';
          alert(msg);
        }
      } catch (err) {
        alert('Network error.');
      }
    }

    // --- Proposals ---

    async function loadProposals() {
      var container = document.getElementById('proposals-container');
      try {
        var res = await API.get('/reviews/pending?limit=50');

        if (res.status === 403) {
          container.innerHTML = '<div class="alert alert-warning">Review access required. Keep contributing to earn this permission.</div>';
          return;
        }

        if (res.status !== 200 || !res.data || !res.data.items) {
          container.innerHTML = '<p class="text-muted">No proposed edits.</p>';
          return;
        }

        var proposals = res.data.items;
        if (proposals.length === 0) {
          container.innerHTML = '<p class="text-muted">No proposed edits pending.</p>';
          return;
        }

        container.innerHTML = proposals.map(renderProposal).join('');

        container.querySelectorAll('.proposal-merge-btn').forEach(function(btn) {
          btn.addEventListener('click', async function() {
            var b = this;
            b.disabled = true;
            try {
              var res = await API.put('/changesets/' + b.dataset.id + '/merge');
              if (res.status === 200) loadProposals();
              else alert((res.data && res.data.error) ? res.data.error.message : 'Merge failed');
            } catch (err) { alert('Network error.'); }
            b.disabled = false;
          });
        });
        container.querySelectorAll('.proposal-reject-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            openRejectModal(this.dataset.id);
          });
        });
      } catch (err) {
        container.innerHTML = '<p class="text-muted">Could not load proposals.</p>';
      }
    }

    function renderProposal(p) {
      var proposer = p.proposedByName ? escapeHtml(p.proposedByName) : 'Unknown';
      var diffHtml = '';

      if (p.original_content) {
        var diffResult = computeWordDiff(p.original_content, p.content);
        diffHtml = '<div class="diff-container">' +
          '<div class="diff-panel">' +
            '<div class="diff-panel-header">Original</div>' +
            diffResult.left +
          '</div>' +
          '<div class="diff-panel">' +
            '<div class="diff-panel-header">Proposed</div>' +
            diffResult.right +
          '</div>' +
        '</div>';
      } else {
        diffHtml = '<div class="diff-container">' +
          '<div class="diff-panel s-634a28be">' +
            '<div class="diff-panel-header">New chunk</div>' +
            escapeHtml(p.content) +
          '</div>' +
        '</div>';
      }

      var topicLink = '';
      if (p.topicSlug && p.topicLang) {
        topicLink = '<a href="./topic.html?slug=' + encodeURIComponent(p.topicSlug) + '&lang=' + encodeURIComponent(p.topicLang) + '">' + escapeHtml(p.topicTitle) + '</a>';
      } else if (p.topicTitle) {
        topicLink = escapeHtml(p.topicTitle);
      }

      var discussionLink = '';
      if (p.agoraiConversationId) {
        discussionLink = '<span class="sep">&middot;</span><span title="Has discussion">&#128172; Discussion</span>';
      }

      return '<div class="review-item">' +
        '<div class="review-bar trust-medium"></div>' +
        '<div class="review-body">' +
          diffHtml +
          '<div class="review-meta s-05460b51">' +
            (topicLink ? '<span>' + topicLink + '</span><span class="sep">&middot;</span>' : '') +
            '<span>v' + p.version + '</span>' +
            '<span class="sep">&middot;</span>' +
            '<span>by ' + proposer + '</span>' +
            '<span class="sep">&middot;</span>' +
            '<span>' + timeAgo(p.createdAt) + '</span>' +
            discussionLink +
          '</div>' +
        '</div>' +
        '<div class="review-actions">' +
          '<button class="btn btn-primary btn-sm proposal-merge-btn" data-id="' + p.changesetId + '">Merge</button>' +
          '<button class="btn btn-danger btn-sm proposal-reject-btn" data-id="' + p.changesetId + '">Reject</button>' +
        '</div>' +
      '</div>';
    }

    // --- Reject modal ---

    function openRejectModal(changesetId) {
      rejectingChangesetId = changesetId;
      document.getElementById('reject-reason').value = '';
      document.getElementById('reject-report').checked = false;
      document.getElementById('reject-modal').style.display = 'flex';
      document.getElementById('reject-reason').focus();
    }

    function closeRejectModal() {
      rejectingChangesetId = null;
      document.getElementById('reject-modal').style.display = 'none';
    }

    async function confirmReject() {
      var reason = document.getElementById('reject-reason').value.trim();
      if (!reason) {
        document.getElementById('reject-reason').style.borderColor = '#b06060';
        return;
      }
      var report = document.getElementById('reject-report').checked;
      var btn = document.getElementById('reject-confirm');
      btn.disabled = true;
      btn.textContent = 'Rejecting...';

      try {
        var res = await API.put('/changesets/' + rejectingChangesetId + '/reject', { reason: reason, report: report });
        if (res.status === 200) {
          closeRejectModal();
          loadProposals();
        } else {
          alert((res.data && res.data.error) ? res.data.error.message : 'Reject failed');
        }
      } catch (err) {
        alert('Network error.');
      }
      btn.disabled = false;
      btn.textContent = 'Reject';
    }

    // --- Word diff ---

    function computeWordDiff(oldText, newText) {
      var oldWords = oldText.split(/(\s+)/);
      var newWords = newText.split(/(\s+)/);
      var m = oldWords.length;
      var n = newWords.length;

      // LCS table
      var dp = [];
      for (var i = 0; i <= m; i++) {
        dp[i] = [];
        for (var j = 0; j <= n; j++) {
          if (i === 0 || j === 0) dp[i][j] = 0;
          else if (oldWords[i - 1] === newWords[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
          else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }

      // Backtrack
      var ops = [];
      var i = m, j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
          ops.unshift({ type: 'eq', old: oldWords[i - 1], new: newWords[j - 1] });
          i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
          ops.unshift({ type: 'ins', new: newWords[j - 1] });
          j--;
        } else {
          ops.unshift({ type: 'del', old: oldWords[i - 1] });
          i--;
        }
      }

      var left = '', right = '';
      for (var k = 0; k < ops.length; k++) {
        var op = ops[k];
        if (op.type === 'eq') {
          left += escapeHtml(op.old);
          right += escapeHtml(op.new);
        } else if (op.type === 'del') {
          left += '<del>' + escapeHtml(op.old) + '</del>';
        } else {
          right += '<ins>' + escapeHtml(op.new) + '</ins>';
        }
      }

      return { left: left, right: right };
    }
