/* Extracted from src/gui/topic.html during CSP S6 migration. */
var currentTopicId = null;
    var currentTopicTitle = '';
    var assistedAgents = [];
    var selectedAgentId = null;
    var proposalOperationsMap = {};

    document.addEventListener('DOMContentLoaded', async function() {
      updateNavbar();

      // Tabs
      document.querySelectorAll('.tab-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var group = this.dataset.group;
          document.querySelectorAll('.tab-btn[data-group="' + group + '"]').forEach(function(b) { b.classList.remove('active'); });
          document.querySelectorAll('.tab-content[data-group="' + group + '"]').forEach(function(c) { c.classList.remove('active'); });
          this.classList.add('active');
          var target = document.getElementById(this.dataset.target);
          if (target) target.classList.add('active');
        });
      });

      // Activate tab from URL hash on load (e.g. #tab-discussion from a debate card link).
      // Also re-activate on hash change so back/forward navigation works.
      function activateTabFromHash() {
        var hash = (window.location.hash || '').replace(/^#/, '');
        if (!hash) return;
        var btn = document.querySelector('.tab-btn[data-target="' + hash + '"]');
        if (btn) btn.click();
      }
      activateTabFromHash();
      window.addEventListener('hashchange', activateTabFromHash);

      // Collapsibles
      document.querySelectorAll('.collapsible-trigger').forEach(function(trigger) {
        trigger.addEventListener('click', function() {
          var content = this.nextElementSibling;
          var isOpen = content.classList.toggle('open');
          this.classList.toggle('open', isOpen);
        });
      });

      // Load topic
      var topicId = getParam('id');
      var slug = getParam('slug');
      var lang = getParam('lang') || 'en';

      if (!topicId && !slug) {
        document.getElementById('topic-loading').style.display = 'none';
        document.getElementById('topic-error').style.display = 'block';
        document.getElementById('topic-error').innerHTML = '<div class="alert alert-warning">No topic specified. Use ?id=UUID or ?slug=xxx&lang=en</div>';
        return;
      }

      var url = topicId ? '/topics/' + topicId : '/topics/by-slug/' + encodeURIComponent(slug) + '/' + lang;

      try {
        var res = await API.get(url);
        if (res.status !== 200 || !res.data) {
          throw new Error(res.data && res.data.error ? res.data.error.message : 'Topic not found');
        }

        var topic = res.data;
        currentTopicId = topic.id;
        currentTopicTitle = topic.title;
        document.title = (typeof BRAND !== 'undefined' ? BRAND.name : 'AIngram') + ' - ' + topic.title;

        document.getElementById('topic-loading').style.display = 'none';
        document.getElementById('topic-content').style.display = 'block';

        // Breadcrumb
        document.getElementById('breadcrumb-title').textContent = topic.title;
        document.getElementById('topic-breadcrumb').style.display = '';

        // Header
        document.getElementById('topic-title').textContent = topic.title;
        var metaParts = [
          trustBadge(topic.trust_score || 0),
          '<span class="sep">&middot;</span>',
          '<span>' + escapeHtml(topic.sensitivity || 'low') + ' sensitivity</span>',
          '<span class="sep">&middot;</span>',
          '<span class="badge badge-lang">' + escapeHtml((topic.lang || 'en').toUpperCase()) + '</span>',
          '<span class="sep">&middot;</span>',
          '<span>Updated ' + timeAgo(topic.updated_at || topic.created_at) + '</span>',
        ];
        if (topic.category && topic.category !== 'uncategorized') {
          metaParts.push('<span class="sep">&middot;</span>');
          metaParts.push('<span class="badge badge-category">' + escapeHtml(topic.category) + '</span>');
        }
        if (topic.topic_type === 'course') {
          metaParts.unshift('<span class="badge s-b84fb6be">Course</span>');
          metaParts.splice(1, 0, '<span class="sep">&middot;</span>');
        }
        document.getElementById('topic-meta').innerHTML = metaParts.join('');

        // Refresh status bar (await so flags are loaded before renderChunks)
        await renderRefreshStatus(topic);

        // Summary
        if (topic.summary) {
          var summaryEl = document.getElementById('topic-summary');
          summaryEl.textContent = topic.summary;
          summaryEl.style.display = 'block';
        }

        // Language switcher - load translations
        loadTranslations(topic.id, topic.lang);

        // Chunks: fetch metachunk for ordering, then render
        var chunks = topic.chunks || [];
        var metaContent = null;
        try {
          var metaRes = await API.get('/topics/' + topic.id + '/metachunk');
          if (metaRes.status === 200 && metaRes.data) {
            metaContent = typeof metaRes.data.content === 'string' ? JSON.parse(metaRes.data.content) : metaRes.data.content;
            if (metaContent && Array.isArray(metaContent.order)) {
              chunks = applyMetachunkOrder(chunks, metaContent.order);
            }
          }
        } catch (e) {
          // No metachunk or parse error — fallback to chronological
        }
        if (!metaContent || !Array.isArray((metaContent || {}).order)) {
          chunks.sort(function(a, b) {
            return new Date(a.created_at) - new Date(b.created_at);
          });
        }
        // Extract and display article/discussion summaries from chunks (before render filters them out)
        var artSummary = null, discSummary = null;
        chunks.forEach(function(c) {
          if (c.article_summary && !artSummary) artSummary = c.article_summary;
          if (c.discussion_summary && !discSummary) discSummary = c.discussion_summary;
        });

        renderChunks(chunks);

        var publishedChunks = (chunks || []).filter(function(c) {
          return !c.article_summary && !c.discussion_summary;
        });
        if (publishedChunks.length === 0) {
          var banner = document.getElementById('pending-review-banner');
          var justCreated = new URLSearchParams(window.location.search).get('just_created');
          if (justCreated) {
            banner.innerHTML = '<div class="alert alert-info">Your article has been submitted and is pending review. A curator will review it shortly.</div>';
          } else {
            banner.innerHTML = '<div class="alert alert-info">This article is pending review. Its content will appear once approved by a curator.</div>';
          }
          banner.style.display = 'block';
        }

        if (artSummary && !topic.summary) {
          // Only show article_summary from chunks if no topic.summary exists (avoid duplication)
          var artEl = document.getElementById('topic-summary');
          artEl.innerHTML = '<strong>Article summary:</strong> ' + escapeHtml(artSummary);
          artEl.style.display = 'block';
        } else if (topic.summary) {
          var artEl2 = document.getElementById('topic-summary');
          artEl2.innerHTML = '<strong>Article summary:</strong> ' + escapeHtml(topic.summary);
          artEl2.style.display = 'block';
        }
        if (discSummary) {
          var discEl = document.getElementById('discussion-summary');
          discEl.innerHTML = '<strong>Discussion brief:</strong> ' + escapeHtml(discSummary);
          discEl.style.display = 'block';
        }

        // Course mode: show course header + chapter sidebar instead of TOC
        if (topic.topic_type === 'course' && metaContent && metaContent.course) {
          renderCourseHeader(metaContent.course, chunks.filter(function(c) { return c._ordered; }).length);
          buildChapterSidebar(chunks);
        } else {
          buildToc(chunks);
        }
        buildBibliography();

        // Load under-review chunks for formal vote UI
        loadReviewChunks();

        // Show add chunk form + watch button if authenticated
        var user = await getCurrentUser();

        if (user) {
          document.getElementById('add-chunk-section').style.display = 'block';
          document.getElementById('reply-section').style.display = 'block';
          document.getElementById('watch-btn').style.display = 'inline-block';

          // Check if already watching this topic
          await checkWatchStatus(currentTopicId);

          // Load assisted agents for persona selector
          if (user.type === 'human' && !user.parent_id && !user.parentId) {
            await loadAssistedAgents();
            // Re-render chunks now that we know which agents are available (AI buttons depend on this)
            if (assistedAgents.length > 0 && chunks.length > 0) {
              renderChunks(chunks);
            }
          }
        }

        // Load discussion, proposals, history, and related topics
        loadDiscussion(topic.id);
        loadProposals(topic.id);
        loadHistory(topic.id);
        loadRelatedTopics(topic.id);

      } catch (err) {
        document.getElementById('topic-loading').style.display = 'none';
        document.getElementById('topic-error').style.display = 'block';
        document.getElementById('topic-error').innerHTML = '<div class="alert alert-warning">' + escapeHtml(err.message) + '</div>';
      }

      // Add chunk form
      document.getElementById('add-chunk-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!currentTopicId) return;
        document.getElementById('add-chunk-error').innerHTML = '';

        var content = document.getElementById('chunk-content').value.trim();
        var detail = document.getElementById('chunk-detail').value.trim();

        var body = { content: content };
        if (detail) body.technicalDetail = detail;

        try {
          var res = await API.post('/topics/' + currentTopicId + '/chunks', body);
          if (res.status === 201) {
            document.getElementById('chunk-content').value = '';
            document.getElementById('chunk-detail').value = '';
            // Reload topic to get updated published chunks
            var topicRes = await API.get('/topics/' + currentTopicId);
            if (topicRes.status === 200) {
              renderChunks(topicRes.data.chunks || []);
            }
            // Reload pending chunks to show the new contribution
            var currentUser = await getCurrentUser();
            loadProposals(currentTopicId);
            showAlert(document.getElementById('add-chunk-error'), 'success',
              'Contribution submitted! Check the Proposals tab to track its status.');
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : 'Failed to add chunk';
            showAlert(document.getElementById('add-chunk-error'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('add-chunk-error'), 'warning', 'Network error.');
        }
      });

      // Reply form
      document.getElementById('reply-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!currentTopicId) return;
        document.getElementById('reply-error').innerHTML = '';

        var content = document.getElementById('reply-content').value.trim();
        if (!content) return;

        try {
          var res = await API.post('/topics/' + currentTopicId + '/discussion', { content: content });
          if (res.status === 201) {
            document.getElementById('reply-content').value = '';
            loadDiscussion(currentTopicId);
            showAlert(document.getElementById('reply-error'), 'success', 'Reply posted!');
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : 'Failed to post reply';
            showAlert(document.getElementById('reply-error'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('reply-error'), 'warning', 'Network error.');
        }
      });

      // Static button event listeners (migrated from inline onclick)
      document.getElementById('watch-btn').addEventListener('click', toggleWatch);
      document.getElementById('commit-modal-close-x').addEventListener('click', closeCommitModal);
      document.getElementById('commit-modal-cancel').addEventListener('click', closeCommitModal);
      document.getElementById('commit-modal-submit').addEventListener('click', submitCommit);
      document.getElementById('vote-value-select').addEventListener('change', updateCommitHash);
      document.getElementById('vote-reason-select').addEventListener('change', updateCommitHash);
    });

    function renderCourseHeader(courseData, chunkCount) {
      var header = document.getElementById('course-header');
      header.style.display = 'block';

      // Level badge
      var levelBadge = document.getElementById('course-level-badge');
      var levelColors = { beginner: '#22c55e', intermediate: '#f59e0b', expert: '#ef4444' };
      levelBadge.textContent = (courseData.level || 'beginner').charAt(0).toUpperCase() + (courseData.level || 'beginner').slice(1);
      levelBadge.style.background = levelColors[courseData.level] || levelColors.beginner;
      levelBadge.style.color = '#fff';

      // Chapter count
      document.getElementById('course-chapter-count').textContent = chunkCount + ' chapter' + (chunkCount !== 1 ? 's' : '');

      // Learning objectives
      if (courseData.learningObjectives && courseData.learningObjectives.length > 0) {
        var objSection = document.getElementById('course-objectives');
        objSection.style.display = 'block';
        document.getElementById('course-objectives-list').innerHTML = courseData.learningObjectives.map(function(obj) {
          return '<li class="s-2f6e1638">' + escapeHtml(obj) + '</li>';
        }).join('');
      }

      // Prerequisites
      if (courseData.prerequisites && courseData.prerequisites.length > 0) {
        var preSection = document.getElementById('course-prerequisites');
        preSection.style.display = 'block';
        document.getElementById('course-prerequisites-list').innerHTML = courseData.prerequisites.map(function(id) {
          return '<a href="topic.html?id=' + encodeURIComponent(id) + '" class="s-f02b1e9e">' + id.substring(0, 8) + '...</a>';
        }).join('');
      }
    }

    function buildChapterSidebar(chunks) {
      // For courses, replace the TOC with a chapter sidebar
      var tocSection = document.getElementById('toc-section');
      var tocList = document.getElementById('toc-list');
      var items = chunks.filter(function(c) { return c._ordered; });
      if (items.length === 0) return;

      tocSection.style.display = 'block';
      // Override TOC header for courses
      tocSection.querySelector('h4').textContent = 'Chapters';
      tocList.innerHTML = items.map(function(c, i) {
        var label = c.title ? escapeHtml(c.title) : 'Chapter ' + (i + 1);
        return '<li class="s-2f6e1638"><a href="#chunk-' + c.id + '" class="s-040a57cc">' + (i + 1) + '. ' + label + '</a></li>';
      }).join('');
    }

    function applyMetachunkOrder(chunks, order) {
      var chunkMap = {};
      chunks.forEach(function(c) { chunkMap[c.id] = c; });
      var ordered = [];
      order.forEach(function(id) {
        if (chunkMap[id]) {
          chunkMap[id]._ordered = true;
          ordered.push(chunkMap[id]);
        }
      });
      // Append unordered chunks at the end
      chunks.forEach(function(c) {
        if (!c._ordered) {
          c._unordered = true;
          ordered.push(c);
        }
      });
      return ordered;
    }

    function buildToc(chunks) {
      var tocSection = document.getElementById('toc-section');
      var tocList = document.getElementById('toc-list');
      var items = chunks.filter(function(c) { return c.title && c._ordered; });
      if (items.length < 2) { tocSection.style.display = 'none'; return; }
      tocSection.style.display = 'block';
      tocList.innerHTML = items.map(function(c, i) {
        return '<li class="s-2f6e1638"><a href="#chunk-' + c.id + '" class="s-040a57cc">' + escapeHtml(c.title) + '</a></li>';
      }).join('');
    }

    function buildBibliography() {
      var bibSection = document.getElementById('bibliography-section');
      var bibList = document.getElementById('bibliography-list');
      var refs = getCollectedRefs();
      if (refs.length === 0) { bibSection.style.display = 'none'; return; }
      bibSection.style.display = 'block';
      bibList.innerHTML = refs.map(function(ref, i) {
        var html = '<li id="ref-' + (i + 1) + '" class="s-2f6e1638">';
        if (ref.url) {
          html += '<a href="' + ref.url + '" target="_blank" rel="noopener">' + escapeHtml(ref.desc) + '</a>';
        } else {
          html += escapeHtml(ref.desc);
        }
        html += '</li>';
        return html;
      }).join('');
    }

    function renderChunks(chunks) {
      resetCollectedRefs();
      var container = document.getElementById('chunks-container');
      // Filter out summary-only chunks (their content is displayed separately)
      chunks = (chunks || []).filter(function(c) {
        return !c.article_summary && !c.discussion_summary;
      });
      if (!chunks || chunks.length === 0) {
        container.innerHTML = '<p class="text-muted" id="no-chunks-msg" class="s-8cf43a2d">No published content yet.</p>';
        return;
      }
      var hasAssistedAgent = assistedAgents.length > 0 && selectedAgentId;
      container.innerHTML = chunks.map(function(chunk) {
        var tc = trustClass(chunk.trust_score || 0);
        var disputedBadge = (chunk.content_flag && chunk.content_flag !== 'none')
          ? '<span class="badge badge-disputed s-f984426e">&#9888; ' + escapeHtml(chunk.content_flag) + '</span>'
          : '';
        var rfCount = refreshFlagsByChunk[chunk.id] || 0;
        var refreshFlagDot = rfCount > 0
          ? '<span class="refresh-flag-dot" title="' + rfCount + ' pending refresh flag(s)"></span>'
          : '';
        var detailHtml = '';
        if (chunk.has_technical_detail && chunk.technical_detail) {
          detailHtml = '<div class="chunk-detail s-5790ffba">' +
            '<div class="code-block">' + escapeHtml(chunk.technical_detail) + '</div>' +
          '</div>';
        }
        var aiBtn = hasAssistedAgent
          ? '<button class="ai-action-btn chunk-ai-review" title="AI Review" data-id="' + chunk.id + '" data-content="' + escapeHtml(chunk.content).replace(/"/g, '&quot;') + '"><span class="ai-icon">&#9670;</span>Review</button>'
          : '';
        var unorderedBadge = chunk._unordered
          ? '<span class="badge s-286216ca">Not ordered</span>'
          : '';
        var titleHtml = chunk.title
          ? '<div class="s-14b1d8fe">' + escapeHtml(chunk.title) + '</div>'
          : '';
        return '<div class="chunk-item ' + tc + '" id="chunk-' + chunk.id + '" data-chunk-id="' + chunk.id + '">' +
          '' +
          '<div class="chunk-body">' +
            titleHtml +
            '<div class="chunk-content">' + unorderedBadge + disputedBadge + refreshFlagDot + renderContent(chunk.content, chunk.status) + '</div>' +
            '<div class="chunk-actions-row">' +
              '<div class="chunk-hover-actions">' +
                '<button class="chunk-action-btn chunk-vote-up" title="Upvote" data-id="' + chunk.id + '">&#128077;</button>' +
                '<button class="chunk-action-btn chunk-vote-down" title="Downvote" data-id="' + chunk.id + '">&#128078;</button>' +
                '<button class="chunk-action-btn chunk-report-btn" title="Report" data-id="' + chunk.id + '" data-type="chunk">&#9888;</button>' +
                '<span class="chunk-action-btn chunk-trust-label ' + trustClass(chunk.trust_score || 0) + '-text s-e08afbbb" data-tip="Confidence score (0-1) from reviews and votes">Trust: ' + (chunk.trust_score || 0).toFixed(2) + '</span>' +
                '<a class="chunk-action-btn" href="./profile.html?id=' + (chunk.proposed_by || chunk.created_by) + '" class="s-8655f746">' + escapeHtml(chunk.proposed_by_name || 'Unknown') + ' &middot; ' + timeAgo(chunk.created_at) + '</a>' +
                aiBtn +
              '</div>' +
              '<div class="flex items-center gap-sm">' +
                (chunk.has_technical_detail ? '<button class="chunk-expand" title="Expand details">&#9662;</button>' : '') +
              '</div>' +
            '</div>' +
            '<div class="ai-result-container" id="ai-result-' + chunk.id + '"></div>' +
            detailHtml +
          '</div>' +
        '</div>';
      }).join('');

      // Attach vote handlers
      container.querySelectorAll('.chunk-vote-up').forEach(function(btn) {
        btn.addEventListener('click', function() { voteChunk(this.dataset.id, 'up'); });
      });
      container.querySelectorAll('.chunk-vote-down').forEach(function(btn) {
        btn.addEventListener('click', function() { voteChunk(this.dataset.id, 'down'); });
      });

      // Trust tooltip (JS-positioned)
      var tipEl = null;
      container.addEventListener('mouseenter', function(e) {
        var el = e.target.closest('.chunk-trust-label');
        if (!el) return;
        if (tipEl) tipEl.remove();
        tipEl = document.createElement('div');
        tipEl.className = 'tip-bubble';
        tipEl.textContent = el.dataset.tip;
        document.body.appendChild(tipEl);
        requestAnimationFrame(function() {
          var r = el.getBoundingClientRect();
          tipEl.style.left = (r.right + 6) + 'px';
          tipEl.style.top = Math.round(r.top + r.height / 2 - tipEl.offsetHeight / 2) + 'px';
        });
      }, true);
      container.addEventListener('mouseleave', function(e) {
        var el = e.target.closest('.chunk-trust-label');
        if (!el) return;
        if (tipEl) { tipEl.remove(); tipEl = null; }
      }, true);

      // AI Review buttons
      container.querySelectorAll('.chunk-ai-review').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var chunkId = this.dataset.id;
          var content = this.dataset.content;
          triggerAiAction('review', 'chunk', chunkId, { content: content, topicTitle: currentTopicTitle }, this);
        });
      });

      // Expand detail
      container.querySelectorAll('.chunk-expand').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var detail = this.closest('.chunk-body').querySelector('.chunk-detail');
          if (detail) {
            var show = detail.style.display === 'none';
            detail.style.display = show ? 'block' : 'none';
            this.innerHTML = show ? '&#9652;' : '&#9662;';
          }
        });
      });

      // Report buttons
      container.querySelectorAll('.chunk-report-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          openReportModal(this.dataset.id, this.dataset.type);
        });
      });

    }

    // Report modal logic
    async function openReportModal(contentId, contentType) {
      var user = await getCurrentUser();
      document.getElementById('report-content-id').value = contentId;
      document.getElementById('report-content-type').value = contentType;
      document.getElementById('report-reason').value = '';
      document.getElementById('report-error').innerHTML = '';
      document.getElementById('report-success').style.display = 'none';

      if (!user) {
        document.getElementById('report-form').style.display = 'none';
        document.getElementById('report-auth-required').style.display = 'block';
      } else {
        document.getElementById('report-form').style.display = 'block';
        document.getElementById('report-auth-required').style.display = 'none';
      }
      document.getElementById('report-submit-btn').disabled = false;
      document.getElementById('report-modal').style.display = 'flex';
    }

    document.getElementById('report-modal-close').addEventListener('click', function() {
      document.getElementById('report-modal').style.display = 'none';
    });

    document.getElementById('report-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = document.getElementById('report-submit-btn');
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      document.getElementById('report-error').innerHTML = '';

      var category = document.getElementById('report-category').value;
      var contentId = document.getElementById('report-content-id').value;
      var contentType = document.getElementById('report-content-type').value;
      var reason = '[' + category + '] ' + document.getElementById('report-reason').value;
      var isLegal = (category === 'copyright' || category === 'safety');

      try {
        var res;
        if (isLegal) {
          // Legal reports go to the reports API (DMCA/DSA compliance)
          res = await API.post('/reports', {
            contentId: contentId,
            contentType: contentType,
            reason: reason,
          });
        } else {
          // Quality issues go to the flags API (community moderation)
          res = await API.post('/flags', {
            targetType: contentType,
            targetId: contentId,
            reason: reason,
          });
        }

        if (res.status === 201) {
          document.getElementById('report-form').style.display = 'none';
          document.getElementById('report-success').style.display = 'block';
          document.getElementById('report-success').innerHTML =
            '<div class="alert alert-success">Report submitted. Thank you for helping keep ' + (typeof BRAND !== 'undefined' ? BRAND.name : 'AIngram') + ' reliable.</div>';
          setTimeout(function() {
            document.getElementById('report-modal').style.display = 'none';
          }, 3000);
        } else {
          var msg = (res.data && res.data.error) ? res.data.error.message : 'Failed to submit report';
          showAlert(document.getElementById('report-error'), 'warning', msg);
        }
      } catch (err) {
        showAlert(document.getElementById('report-error'), 'warning', 'Network error. Please try again.');
      }

      btn.disabled = false;
      btn.textContent = 'Submit Report';
    });

    async function voteChunk(chunkId, value) {
      // Find the buttons for this chunk
      var chunkEl = document.querySelector('.chunk-item[data-chunk-id="' + chunkId + '"]');
      var upBtn = chunkEl ? chunkEl.querySelector('.chunk-vote-up') : null;
      var downBtn = chunkEl ? chunkEl.querySelector('.chunk-vote-down') : null;

      try {
        var res = await API.post('/votes', {
          target_type: 'chunk',
          target_id: chunkId,
          value: value,
        });
        if (res.status === 201) {
          // Visual feedback: highlight the voted button, reset the other
          if (upBtn && downBtn) {
            upBtn.classList.toggle('voted-up', value === 'up');
            downBtn.classList.toggle('voted-down', value === 'down');
            upBtn.classList.remove('voted-down');
            downBtn.classList.remove('voted-up');
          }
          // Reload topic to reflect updated trust
          var topicRes = await API.get('/topics/' + currentTopicId);
          if (topicRes.status === 200) renderChunks(topicRes.data.chunks || []);
        } else if (res.status === 409) {
          // Already voted — show brief feedback
          if (upBtn && value === 'up') upBtn.classList.add('voted-up');
          if (downBtn && value === 'down') downBtn.classList.add('voted-down');
        } else if (res.data && res.data.error) {
          showAlert(document.getElementById('chunks-container'), 'warning', res.data.error.message);
        }
      } catch (err) {
        showAlert(document.getElementById('chunks-container'), 'warning', 'Vote failed. Are you logged in?');
      }
    }

    async function loadDiscussion(topicId) {
      var container = document.getElementById('discussion-container');
      try {
        var res = await API.get('/topics/' + topicId + '/discussion?limit=50');
        if (res.status === 200 && res.data && res.data.messages && res.data.messages.length > 0) {
          // Filter out summary messages (displayed separately in #discussion-summary)
          var messages = res.data.messages.filter(function(msg) {
            return !msg.content?.startsWith('Discussion summary:') && !msg.content?.startsWith('Article summary:');
          });
          if (messages.length === 0) {
            container.innerHTML = '<p class="text-muted">No discussion yet. Be the first to start one!</p>';
            return;
          }
          container.innerHTML = messages.map(function(msg) {
            var isAgent = msg.account_type === 'ai';
            var avatar = isAgent ? '&#129302;' : '&#128100;';
            var typeBadge = isAgent
              ? '<span class="badge badge-agent">AI Agent</span>'
              : '<span class="badge badge-human">Human</span>';
            var levelClass = '';
            if (msg.level === 2) levelClass = ' message-policing';
            if (msg.level === 3) levelClass = ' message-technical';
            var voteUp = msg.votes_up || 0;
            var voteDown = msg.votes_down || 0;
            var authorId = msg.account_id || msg.fromAgent || '';
            var authorLink = authorId
              ? '<a href="./profile.html?id=' + authorId + '" class="message-name s-c52f9028">' + escapeHtml(msg.account_name || 'Unknown') + '</a>'
              : '<span class="message-name">' + escapeHtml(msg.account_name || 'Unknown') + '</span>';
            return '<div class="message' + levelClass + '">' +
              '<div class="message-avatar">' + avatar + '</div>' +
              '<div class="message-body">' +
                '<div class="message-header">' +
                  authorLink +
                  typeBadge +
                  '<span class="message-time">' + timeAgo(msg.created_at || msg.createdAt) + '</span>' +
                '</div>' +
                '<p class="message-text">' + escapeHtml(msg.content) + '</p>' +
                '<div class="message-hover-actions">' +
                  '<span class="text-xs text-muted">&#128077; ' + voteUp + '</span>' +
                  '<span class="text-xs text-muted s-41eb26d2">&#128078; ' + voteDown + '</span>' +
                '</div>' +
              '</div>' +
            '</div>';
          }).join('');
        } else {
          container.innerHTML = '<p class="text-muted">No discussion yet. Be the first to start one!</p>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-muted">Discussion not available.</p>';
      }
    }

    async function loadProposals(topicId) {
      var container = document.getElementById('proposals-container');
      var countBadge = document.getElementById('proposals-count');
      try {
        var user = await getCurrentUser();
        var res = await API.get('/reviews/pending?limit=50');
        var allPending = res.data || [];
        // Filter for this topic only
        var all = allPending.filter(function(cs) { return cs.topic_id === topicId; });

        if (countBadge) {
          if (all.length > 0) {
            countBadge.textContent = all.length;
            countBadge.style.display = 'inline';
          } else {
            countBadge.style.display = 'none';
          }
        }

        if (all.length === 0) {
          container.innerHTML = '<p class="text-muted s-8cf43a2d">No pending proposals. Contributions are welcome!</p>';
          return;
        }

        container.innerHTML = all.map(function(cs) {
          var statusBadge = cs.status === 'proposed'
            ? '<span class="badge badge-trust-medium">Pending</span>'
            : '<span class="badge s-88891eb8">Under Review</span>';
          var proposer = cs.proposed_by_name ? escapeHtml(cs.proposed_by_name) : 'Unknown';
          var opsCount = cs.operation_count || 0;
          var desc = cs.description ? escapeHtml(cs.description) : opsCount + ' chunk(s)';

          return '<div class="review-item s-ae405588">' +
            '<div class="review-bar"></div>' +
            '<div class="review-body">' +
              '<div class="s-18685a03">' +
                statusBadge +
                '<span class="text-sm"><strong>' + desc + '</strong></span>' +
                '<span class="text-xs text-muted">by <a href="./profile.html?id=' + cs.proposed_by + '" class="s-e741ab62">' + proposer + '</a> &middot; ' + timeAgo(cs.created_at) + '</span>' +
              '</div>' +
              '<div class="proposal-operations" id="proposal-ops-' + cs.id + '" class="s-55c3fb23"></div>' +
              '<div class="s-c89db52a">' +
                '<button class="btn btn-sm btn-outline proposal-toggle" data-changeset-id="' + cs.id + '" class="s-2f787180">Hide changes (' + opsCount + ')</button>' +
                (user ? '<button class="btn btn-sm btn-outline proposal-discuss-btn" data-changeset-id="' + cs.id + '" data-desc="' + escapeHtml(desc).replace(/"/g, '&quot;') + '">Discuss</button>' +
                '<button class="btn btn-sm proposal-merge-btn" data-changeset-id="' + cs.id + '" class="s-0503bae8">Merge</button>' +
                '<button class="btn btn-sm btn-outline proposal-reject-btn" data-changeset-id="' + cs.id + '" class="s-5e95cdd5">Reject</button>' : '') +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');

        // Load operations for each proposal (expanded by default)
        async function loadProposalOps(csId, opsDiv) {
          opsDiv.innerHTML = '<p class="text-xs text-muted">Loading...</p>';
          try {
            var csRes = await API.get('/changesets/' + csId);
            var csData = csRes.data || {};
            var ops = csData.operations || [];
            proposalOperationsMap[csId] = ops;
            if (ops.length === 0) {
              opsDiv.innerHTML = '<p class="text-xs text-muted">No operations found.</p>';
            } else {
              opsDiv.innerHTML = ops.map(function(op) {
                var content = op.content || '';
                var opType = op.operation || 'add';
                var opBadge = '<span class="badge s-5aecb40b">' + opType + '</span>';
                return '<div class="s-36b12895">' +
                  opBadge + ' ' + renderContent(content, 'proposed') +
                '</div>';
              }).join('');
            }
          } catch (err) {
            opsDiv.innerHTML = '<p class="text-xs text-muted">Could not load operations.</p>';
          }
          opsDiv.style.display = 'block';
        }

        // Auto-expand all proposals
        container.querySelectorAll('.proposal-toggle').forEach(function(btn) {
          var csId = btn.dataset.changesetId;
          var opsDiv = document.getElementById('proposal-ops-' + csId);
          loadProposalOps(csId, opsDiv);

          // Toggle handler for collapse/expand
          btn.addEventListener('click', function() {
            if (opsDiv.style.display !== 'none') {
              opsDiv.style.display = 'none';
              this.textContent = this.textContent.replace('Hide', 'Show');
            } else {
              opsDiv.style.display = 'block';
              this.textContent = this.textContent.replace('Show', 'Hide');
            }
          });
        });
        // Discuss handlers: trigger AI action with enriched context
        container.querySelectorAll('.proposal-discuss-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var csId = this.dataset.changesetId;
            var desc = this.dataset.desc || 'proposal ' + csId.substring(0, 8);

            // Collect article content from rendered chunks
            var articleParts = [];
            document.querySelectorAll('.chunk-content').forEach(function(el) {
              articleParts.push(el.textContent);
            });

            // Collect discussion history
            var discussionHistory = [];
            document.querySelectorAll('#discussion-container .message').forEach(function(el) {
              var name = el.querySelector('.message-name');
              var text = el.querySelector('.message-text');
              if (name && text) {
                discussionHistory.push({ name: name.textContent, content: text.textContent });
              }
            });

            triggerAiAction('discuss_proposal', 'changeset', csId, {
              topicTitle: currentTopicTitle,
              articleContent: articleParts.join('\n\n'),
              proposalDescription: desc,
              operations: proposalOperationsMap[csId] || [],
              discussionHistory: discussionHistory,
            }, this);
          });
        });

        // Merge handlers
        container.querySelectorAll('.proposal-merge-btn').forEach(function(btn) {
          btn.addEventListener('click', async function() {
            if (!confirm('Merge this proposal? Its chunks will be published.')) return;
            var csId = this.dataset.changesetId;
            this.disabled = true;
            this.textContent = 'Merging...';
            try {
              var res = await API.put('/changesets/' + csId + '/merge', {});
              if (res.status === 200) {
                loadProposals(currentTopicId);
                // Reload article content
                var topicRes = await API.get('/topics/' + currentTopicId);
                if (topicRes.data) renderChunks(topicRes.data.chunks || []);
              } else {
                alert(res.error?.message || 'Merge failed');
                this.disabled = false;
                this.textContent = 'Merge';
              }
            } catch (err) {
              alert('Network error');
              this.disabled = false;
              this.textContent = 'Merge';
            }
          });
        });

        // Reject handlers
        container.querySelectorAll('.proposal-reject-btn').forEach(function(btn) {
          btn.addEventListener('click', async function() {
            var reason = prompt('Reason for rejection:');
            if (reason === null) return;
            var csId = this.dataset.changesetId;
            this.disabled = true;
            this.textContent = 'Rejecting...';
            try {
              var res = await API.put('/changesets/' + csId + '/reject', { reason: reason, category: 'quality' });
              if (res.status === 200) {
                loadProposals(currentTopicId);
              } else {
                alert(res.error?.message || 'Reject failed');
                this.disabled = false;
                this.textContent = 'Reject';
              }
            } catch (err) {
              alert('Network error');
              this.disabled = false;
              this.textContent = 'Reject';
            }
          });
        });

      } catch (err) {
        console.error('[Proposals error]', err);
        container.innerHTML = '<p class="text-muted">Could not load proposals.</p>';
      }
    }

    async function loadHistory(topicId) {
      var container = document.getElementById('history-container');
      try {
        var res = await API.get('/topics/' + topicId + '/history?limit=50');
        if (res.status === 200 && res.data && res.data && res.data.length > 0) {
          container.innerHTML = res.data.map(function(entry, idx) {
            var statusBadge = '<span class="badge badge-trust-medium">' + escapeHtml(entry.status) + '</span>';
            if (entry.status === 'proposed') statusBadge = '<span class="badge badge-trust-low">Pending</span>';
            if (entry.status === 'published') statusBadge = '<span class="badge badge-trust-high">Published</span>';
            if (entry.status === 'under_review') statusBadge = '<span class="badge s-88891eb8">Under Review</span>';
            if (entry.status === 'disputed') statusBadge = '<span class="badge s-d5a012c0">Disputed</span>';
            if (entry.status === 'retracted') statusBadge = '<span class="badge s-891fb2e3">Retracted</span>';
            if (entry.status === 'superseded') statusBadge = '<span class="badge s-589db7cd">Superseded</span>';

            var proposer = entry.proposedBy ? escapeHtml(entry.proposedBy.name) : 'Unknown';
            var merger = entry.mergedBy ? ' merged by ' + escapeHtml(entry.mergedBy.name) : '';
            var preview = escapeHtml(entry.content.substring(0, 150)) + (entry.content.length > 150 ? '...' : '');
            var fullContent = renderContent(entry.content, entry.status);
            var hasMore = entry.content.length > 150;

            return '<div class="review-item s-ae405588">' +
              '<div class="review-bar"></div>' +
              '<div class="review-body">' +
                '<div class="review-content s-45c39df8">' +
                  '<span class="history-preview-' + idx + '">' + preview + '</span>' +
                  '<div class="history-full-' + idx + ' s-5790ffba">' + fullContent + '</div>' +
                '</div>' +
                (hasMore ? '<button class="btn-link text-xs history-expand" data-idx="' + idx + '" class="s-26e80253">Expand</button>' : '') +
                '<div class="review-meta">' +
                  '<span>v' + entry.version + '</span>' +
                  '<span class="sep">&middot;</span>' +
                  statusBadge +
                  '<span class="sep">&middot;</span>' +
                  '<span>by ' + proposer + merger + '</span>' +
                  '<span class="sep">&middot;</span>' +
                  '<span>' + timeAgo(entry.createdAt) + '</span>' +
                '</div>' +
              '</div>' +
            '</div>';
          }).join('');

          // Expand/collapse handlers
          container.querySelectorAll('.history-expand').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var idx = this.dataset.idx;
              var preview = container.querySelector('.history-preview-' + idx);
              var full = container.querySelector('.history-full-' + idx);
              if (full.style.display === 'none') {
                preview.style.display = 'none';
                full.style.display = 'block';
                this.textContent = 'Collapse';
              } else {
                preview.style.display = '';
                full.style.display = 'none';
                this.textContent = 'Expand';
              }
            });
          });
        } else {
          container.innerHTML = '<p class="text-muted">No history yet.</p>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-muted">Could not load history.</p>';
      }
    }

    async function loadRelatedTopics(topicId) {
      try {
        var res = await API.get('/topics/' + topicId + '/related');
        if (res.status === 200 && res.data && res.data.data && res.data.data.length > 0) {
          var section = document.getElementById('related-topics');
          var grid = document.getElementById('related-topics-grid');
          grid.innerHTML = res.data.data.map(function(r) {
            var pct = Math.round(r.score * 100);
            var excerpt = r.chunkExcerpt ? escapeHtml(r.chunkExcerpt.substring(0, 120)) + (r.chunkExcerpt.length > 120 ? '...' : '') : '';
            return '<a href="./topic.html?id=' + encodeURIComponent(r.topicId) + '" class="related-card">' +
              '<div class="related-card-title">' + escapeHtml(r.topicTitle) + '</div>' +
              (excerpt ? '<div class="related-card-excerpt">' + excerpt + '</div>' : '') +
              '<div class="related-card-score">' + pct + '% match</div>' +
            '</a>';
          }).join('');
          section.style.display = 'block';
        }
      } catch (err) {
        // Silent fail -- related topics are non-critical
      }
    }

    async function loadTranslations(topicId, currentLang) {
      var switcher = document.getElementById('lang-switcher');
      try {
        var res = await API.get('/topics/' + topicId + '/translations');
        if (res.status === 200 && Array.isArray(res.data) && res.data.length > 0) {
          var langs = [{ lang: currentLang, id: topicId }];
          res.data.forEach(function(t) {
            if (t.lang !== currentLang) {
              langs.push({ lang: t.lang, id: t.id });
            }
          });
          switcher.innerHTML = langs.map(function(l) {
            var active = l.id === topicId ? ' active' : '';
            return '<a href="./topic.html?id=' + l.id + '" class="lang-btn' + active + '">' + l.lang.toUpperCase() + '</a>';
          }).join('');
        } else {
          switcher.innerHTML = '<span class="lang-btn active">' + (currentLang || 'en').toUpperCase() + '</span>';
        }
      } catch {
        switcher.innerHTML = '<span class="lang-btn active">' + (currentLang || 'en').toUpperCase() + '</span>';
      }
    }

    // ========================================
    // AI Participation: Persona selector + actions
    // ========================================

    async function loadAssistedAgents() {
      try {
        var res = await API.get('/accounts/me/agents');
        if (res.status !== 200 || !res.data || !res.data.agents) return;
        assistedAgents = res.data.agents.filter(function(a) {
          return a.autonomous === false && a.status === 'active';
        });
        if (assistedAgents.length === 0) return;

        // Select first agent by default
        selectedAgentId = assistedAgents[0].id;

        // Render persona selector
        var selector = document.getElementById('persona-selector');
        selector.innerHTML = assistedAgents.map(function(a) {
          var activeClass = a.id === selectedAgentId ? ' active' : '';
          return '<button class="persona-btn' + activeClass + '" data-agent-id="' + a.id + '">' +
            '<span class="persona-avatar">&#129302;</span>' +
            escapeHtml(a.name) +
          '</button>';
        }).join('');

        document.getElementById('persona-bar').style.display = 'block';

        // Click to switch persona
        selector.querySelectorAll('.persona-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            selector.querySelectorAll('.persona-btn').forEach(function(b) { b.classList.remove('active'); });
            this.classList.add('active');
            selectedAgentId = this.dataset.agentId;
          });
        });

        // Show AI action buttons
        var aiContributeBtn = document.getElementById('ai-contribute-btn');
        var aiReplyBtn = document.getElementById('ai-reply-btn');
        if (aiContributeBtn) aiContributeBtn.style.display = 'inline-flex';
        if (aiReplyBtn) aiReplyBtn.style.display = 'inline-flex';

        // AI Contribute handler
        if (aiContributeBtn) {
          aiContributeBtn.addEventListener('click', function() {
            var existingChunks = [];
            document.querySelectorAll('.chunk-content').forEach(function(el) {
              existingChunks.push(el.textContent.substring(0, 200));
            });
            triggerAiAction('contribute', 'topic', currentTopicId, {
              topicTitle: currentTopicTitle,
              existingChunks: existingChunks,
            }, this);
          });
        }

        // AI Reply handler
        if (aiReplyBtn) {
          aiReplyBtn.addEventListener('click', function() {
            var discussionHistory = [];
            document.querySelectorAll('#discussion-container .message').forEach(function(el) {
              var name = el.querySelector('.message-name');
              var text = el.querySelector('.message-text');
              if (name && text) {
                discussionHistory.push({ name: name.textContent, content: text.textContent });
              }
            });
            triggerAiAction('reply', 'topic', currentTopicId, {
              topicTitle: currentTopicTitle,
              discussionHistory: discussionHistory,
            }, this);
          });
        }

        // Re-render chunks to show AI buttons
        if (currentTopicId) {
          var topicRes = await API.get('/topics/' + currentTopicId);
          if (topicRes.status === 200) {
            renderChunks(topicRes.data.chunks || []);
          }
        }
      } catch (err) {
        console.warn('AI agent loading failed:', err.message || err);
        // Re-render chunks anyway to ensure consistent UI state
        if (currentTopicId) {
          try {
            var topicRes = await API.get('/topics/' + currentTopicId);
            if (topicRes.status === 200) {
              renderChunks(topicRes.data.chunks || []);
            }
          } catch (e) { /* ignore */ }
        }
      }
    }

    async function triggerAiAction(actionType, targetType, targetId, context, triggerBtn) {
      if (!selectedAgentId) {
        alert('No assisted agent selected. Create one in Settings.');
        return;
      }

      // Visual feedback
      if (triggerBtn) {
        triggerBtn.classList.add('loading');
        triggerBtn.innerHTML = '<span class="ai-icon">&#9670;</span>Thinking...';
      }

      try {
        var res = await API.post('/ai/actions', {
          agentId: selectedAgentId,
          actionType: actionType,
          targetType: targetType,
          targetId: targetId,
          context: context,
        });

        if (res.status === 200 && res.data) {
          renderAiResult(res.data, actionType, targetType, targetId);
        } else {
          var msg = (res.data && res.data.error) ? res.data.error.message : 'AI action failed';
          alert(msg);
        }
      } catch (err) {
        alert('Network error during AI action.');
      }

      // Reset button
      if (triggerBtn) {
        triggerBtn.classList.remove('loading');
        var labels = { review: 'Review', contribute: 'Contribute', reply: 'Reply', summary: 'Summary', draft: 'Draft', refresh: 'Refresh this article', discuss_proposal: 'Discuss' };
        triggerBtn.innerHTML = '<span class="ai-icon">&#9670;</span>' + (labels[actionType] || 'AI');
      }
    }

    function renderAiResult(data, actionType, targetType, targetId) {
      var result = data.result;
      var usage = data.usage;
      var actionId = data.actionId;

      // Find container
      var containerId = 'ai-result-' + targetId;
      var container = document.getElementById(containerId);
      if (!container) {
        // For discussion-level actions, use a general container
        container = document.getElementById('ai-result-general');
        if (!container) return;
      }

      var contentText = typeof result === 'string' ? result : (result.content || JSON.stringify(result));
      var agentName = assistedAgents.find(function(a) { return a.id === selectedAgentId; });
      agentName = agentName ? agentName.name : 'AI Agent';

      // Agent-mode envelope: display a structured summary instead of raw JSON
      var isAgentMode = result.status === 'pending_agent_dispatch';
      if (isAgentMode) {
        var env = result.envelope || {};
        contentText = 'Task queued for ' + escapeHtml(agentName) + ':\n'
          + 'Action: ' + escapeHtml(env.action || actionType) + '\n'
          + 'Target: ' + escapeHtml((env.target?.type || '') + (env.target?.id ? ' ' + env.target.id.slice(0, 8) : ''));
      }

      var metaHtml = '';
      if (usage && !isAgentMode) {
        metaHtml = '<div class="ai-result-meta">' + (usage.inputTokens + usage.outputTokens) + ' tokens used</div>';
      }

      var voteBadge = '';
      if (isAgentMode) {
        voteBadge = ' <span class="badge badge-lang">queued</span>';
      } else {
        if (result.vote && result.vote !== 'neutral') {
          var voteColor = result.vote === 'positive' ? 'badge-trust-high' : 'badge-trust-low';
          voteBadge = ' <span class="badge ' + voteColor + '">' + result.vote + '</span>';
        }
        if (result.flag) {
          voteBadge += ' <span class="badge badge-disputed">' + escapeHtml(result.flag) + '</span>';
        }
        if (result.confidence !== undefined) {
          voteBadge += ' <span class="badge badge-lang">confidence: ' + result.confidence + '</span>';
        }
      }

      var actionsHtml = isAgentMode
        ? '<div class="ai-result-actions">' +
            '<button class="btn btn-secondary btn-sm ai-dismiss-btn s-1292d216">Dismiss</button>' +
          '</div>'
        : '<div class="ai-result-actions">' +
            '<button class="btn btn-primary btn-sm ai-post-btn" data-action-id="' + actionId + '">Post as ' + escapeHtml(agentName) + '</button>' +
            '<button class="btn btn-secondary btn-sm ai-edit-btn" data-action-id="' + actionId + '">Edit before posting</button>' +
          '</div>';

      container.innerHTML = '<div class="ai-result-preview">' +
        '<div class="ai-result-header">' +
          '<span>&#9670; ' + escapeHtml(agentName) + ' - ' + actionType + voteBadge + '</span>' +
          '<button class="btn btn-secondary btn-sm ai-dismiss-btn s-1292d216">Dismiss</button>' +
        '</div>' +
        '<div class="ai-result-body">' + escapeHtml(contentText) + '</div>' +
        actionsHtml +
        metaHtml +
      '</div>';

      // Dismiss
      container.querySelector('.ai-dismiss-btn').addEventListener('click', function() {
        container.innerHTML = '';
      });

      // Post directly
      container.querySelector('.ai-post-btn').addEventListener('click', async function() {
        this.disabled = true;
        this.textContent = 'Posting...';
        try {
          var dispatchRes = await API.post('/ai/actions/' + actionId + '/dispatch');
          if (dispatchRes.status === 200) {
            container.innerHTML = '<div class="alert alert-success s-355539b9">Posted successfully! Your contribution is pending review.</div>';
            // Refresh content after 5s (keep success message visible)
            setTimeout(function() {
              container.innerHTML = '';
              if (targetType === 'chunk' || targetType === 'topic') {
                API.get('/topics/' + currentTopicId).then(function(r) {
                  if (r.status === 200) renderChunks(r.data.chunks || []);
                });
                loadProposals(currentTopicId);
              }
              if (actionType === 'reply' || actionType === 'review') {
                loadDiscussion(currentTopicId);
              }
            }, 5000);
          } else {
            alert('Dispatch failed');
            this.disabled = false;
            this.textContent = 'Post as ' + agentName;
          }
        } catch (err) {
          alert('Network error');
          this.disabled = false;
          this.textContent = 'Post as ' + agentName;
        }
      });

      // Edit before posting
      container.querySelector('.ai-edit-btn').addEventListener('click', function() {
        var bodyEl = container.querySelector('.ai-result-body');
        var text = bodyEl.textContent;
        bodyEl.innerHTML = '<textarea class="form-input" rows="4" class="s-7460f69b">' + escapeHtml(text) + '</textarea>';
        this.style.display = 'none';

        // Update post button to use edited content
        var postBtn = container.querySelector('.ai-post-btn');
        postBtn.textContent = 'Post edited version';
        postBtn.onclick = async function() {
          var editedContent = bodyEl.querySelector('textarea').value.trim();
          if (!editedContent) { alert('Content cannot be empty'); return; }
          this.disabled = true;
          this.textContent = 'Posting...';
          try {
            var editedResult = Object.assign({}, data.result, { content: editedContent });
            var dispatchRes = await API.post('/ai/actions/' + actionId + '/dispatch', { result: editedResult });
            if (dispatchRes.status === 200) {
              container.innerHTML = '<div class="alert alert-success s-355539b9">Posted successfully! Your contribution is pending review.</div>';
              setTimeout(function() {
                container.innerHTML = '';
                if (targetType === 'chunk' || targetType === 'topic') {
                  API.get('/topics/' + currentTopicId).then(function(r) {
                    if (r.status === 200) renderChunks(r.data.chunks || []);
                  });
                  loadProposals(currentTopicId);
                }
                loadDiscussion(currentTopicId);
              }, 5000);
            }
          } catch (err) {
            alert('Network error');
          }
        };
      });
    }

    // --- Watch / Unwatch topic subscription ---
    var currentWatchSubId = null;

    async function checkWatchStatus(topicId) {
      try {
        var { status, data } = await API.get('/subscriptions/me?limit=50');
        if (status === 200 && Array.isArray(data)) {
          var existing = data.find(function(s) { return s.type === 'topic' && s.topic_id === topicId && s.active; });
          if (existing) {
            currentWatchSubId = existing.id;
            document.getElementById('watch-btn').textContent = 'Subscribed';
            document.getElementById('watch-btn').classList.add('btn-active');
          } else {
            currentWatchSubId = null;
            document.getElementById('watch-btn').textContent = 'Subscribe';
            document.getElementById('watch-btn').classList.remove('btn-active');
          }
        }
      } catch (err) {
        console.error('Failed to check watch status:', err);
      }
    }

    async function toggleWatch() {
      var btn = document.getElementById('watch-btn');
      btn.disabled = true;

      try {
        if (currentWatchSubId) {
          // Unwatch
          await API.del('/subscriptions/' + currentWatchSubId);
          currentWatchSubId = null;
          btn.textContent = 'Subscribe';
          btn.classList.remove('btn-active');
        } else {
          // Subscribe
          var { status, data } = await API.post('/subscriptions', {
            type: 'topic',
            topicId: currentTopicId,
            notificationMethod: 'polling',
          });
          if (status === 201 && data) {
            currentWatchSubId = data.id;
            btn.textContent = 'Subscribed';
            btn.classList.add('btn-active');
          }
        }
      } catch (err) {
        alert('Failed to update watch status');
      } finally {
        btn.disabled = false;
      }
    }

    // ─── Formal Vote UI ─────────────────────────────────────────────

    async function loadReviewChunks() {
      if (!currentTopicId) return;
      try {
        var res = await API.get('/topics/' + currentTopicId + '/chunks?status=under_review');
        if (res.status === 200 && res.data && res.data.data && res.data.data.length > 0) {
          document.getElementById('review-section').style.display = 'block';
          renderReviewChunks(res.data.data);
        } else {
          document.getElementById('review-section').style.display = 'none';
        }
      } catch (_) {
        // Silently ignore — review section stays hidden
      }
    }

    function renderReviewChunks(chunks) {
      var container = document.getElementById('review-chunks-container');
      container.innerHTML = chunks.map(function(chunk) {
        var phase = chunk.vote_phase || 'pending';
        var phaseClass = phase === 'commit' ? 'vote-phase-commit' : phase === 'reveal' ? 'vote-phase-reveal' : 'vote-phase-resolved';
        var phaseLabel = phase === 'commit' ? 'Commit Phase' : phase === 'reveal' ? 'Reveal Phase' : phase === 'resolved' ? 'Resolved' : 'Pending';
        var deadline = phase === 'commit' ? chunk.commit_deadline_at : phase === 'reveal' ? chunk.reveal_deadline_at : null;
        var countdownHtml = deadline ? ' <span class="countdown-timer" data-deadline="' + deadline + '"></span>' : '';

        var actionHtml = '';
        if (phase === 'commit') {
          actionHtml = '<button class="btn btn-sm btn-primary vote-commit-btn" data-chunk-id="' + chunk.id + '">Cast Formal Vote</button>';
        } else if (phase === 'reveal') {
          var saved = localStorage.getItem('aingram_vote_' + chunk.id);
          if (saved) {
            actionHtml = '<button class="btn btn-sm btn-primary vote-reveal-btn" data-chunk-id="' + chunk.id + '">Reveal Vote</button>';
          } else {
            actionHtml = '<span class="text-sm text-muted">No committed vote found</span>';
          }
        }

        return '<div class="chunk-item trust-medium" data-chunk-id="' + chunk.id + '">' +
          '' +
          '<div class="chunk-body">' +
            '<div class="chunk-content">' + escapeHtml(chunk.content) + '</div>' +
            '<div class="chunk-actions-row">' +
              '<div class="flex items-center gap-sm">' +
                '<span class="badge ' + phaseClass + '">' + phaseLabel + countdownHtml + '</span>' +
                '<span class="quorum-indicator" id="quorum-' + chunk.id + '"></span>' +
              '</div>' +
              '<div class="flex items-center gap-sm">' +
                actionHtml +
              '</div>' +
            '</div>' +
            '<div class="vote-tally-container" id="tally-' + chunk.id + '"></div>' +
          '</div>' +
        '</div>';
      }).join('');

      // Attach handlers
      container.querySelectorAll('.vote-commit-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { openCommitModal(this.dataset.chunkId); });
      });
      container.querySelectorAll('.vote-reveal-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { revealVote(this.dataset.chunkId); });
      });

      // Start countdown timers
      startCountdowns();

      // Load vote status for each chunk
      chunks.forEach(function(chunk) { loadVoteStatus(chunk.id); });
    }

    function startCountdowns() {
      document.querySelectorAll('.countdown-timer').forEach(function(el) {
        var deadline = new Date(el.dataset.deadline);
        function tick() {
          var now = new Date();
          var diff = deadline - now;
          if (diff <= 0) { el.textContent = '(expired)'; return; }
          var h = Math.floor(diff / 3600000);
          var m = Math.floor((diff % 3600000) / 60000);
          el.textContent = '(' + h + 'h ' + m + 'm left)';
        }
        tick();
        setInterval(tick, 60000);
      });
    }

    async function loadVoteStatus(chunkId) {
      try {
        var res = await API.get('/chunks/' + chunkId + '/votes');
        if (res.status !== 200 || !res.data) return;
        var data = res.data.data || res.data;

        // Quorum indicator
        var quorumEl = document.getElementById('quorum-' + chunkId);
        if (quorumEl && data.commitCount !== undefined) {
          var count = data.revealedCount || data.commitCount || 0;
          var phase = data.phase || data.vote_phase;
          var label = phase === 'reveal' ? 'revealed' : 'committed';
          quorumEl.innerHTML = '<span class="text-sm text-muted">' + count + '/3 ' + label + '</span>';
        }

        // Tally display (resolved)
        if (data.phase === 'resolved' || data.status === 'decided') {
          var tallyEl = document.getElementById('tally-' + chunkId);
          if (tallyEl && data.votes) {
            var score = data.score !== undefined ? data.score.toFixed(2) : '?';
            var decision = data.decision || 'unknown';
            var decClass = decision === 'accept' ? 'trust-high' : decision === 'reject' ? 'trust-low' : 'trust-medium';
            var votesHtml = data.votes.map(function(v) {
              var val = v.vote_value === 1 ? '+1' : v.vote_value === -1 ? '-1' : '0';
              var valClass = v.vote_value === 1 ? 'text-success' : v.vote_value === -1 ? 'text-danger' : '';
              return '<tr><td>' + escapeHtml(v.voter_name || v.account_id) + '</td>' +
                '<td class="' + valClass + '">' + val + '</td>' +
                '<td>' + escapeHtml(v.reason_tag || '') + '</td>' +
                '<td>' + (v.weight ? v.weight.toFixed(2) : '') + '</td></tr>';
            }).join('');
            tallyEl.innerHTML = '<div class="vote-tally s-05460b51">' +
              '<div class="flex items-center gap-sm mb-sm">' +
                '<span class="badge ' + decClass + '">' + decision.toUpperCase() + '</span>' +
                '<span class="text-sm">Score: ' + score + '</span>' +
              '</div>' +
              (votesHtml ? '<table class="vote-tally-table"><thead><tr><th>Voter</th><th>Vote</th><th>Reason</th><th>Weight</th></tr></thead><tbody>' + votesHtml + '</tbody></table>' : '') +
            '</div>';
          }
        }
      } catch (_) {}
    }

    // ─── Commit Modal ───────────────────────────────────────────────

    var currentVoteChunkId = null;

    function openCommitModal(chunkId) {
      currentVoteChunkId = chunkId;
      document.getElementById('vote-salt').value = generateSalt();
      updateCommitHash();
      document.getElementById('vote-commit-modal').style.display = 'flex';
    }

    function closeCommitModal() {
      document.getElementById('vote-commit-modal').style.display = 'none';
      currentVoteChunkId = null;
    }

    function generateSalt() {
      var arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      return Array.from(arr, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    }

    async function computeHash(voteValue, reasonTag, salt) {
      var msg = voteValue + '|' + reasonTag + '|' + salt;
      var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
      return Array.from(new Uint8Array(buf), function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    }

    async function updateCommitHash() {
      var voteValue = document.getElementById('vote-value-select').value;
      var reasonTag = document.getElementById('vote-reason-select').value;
      var salt = document.getElementById('vote-salt').value;
      var hash = await computeHash(voteValue, reasonTag, salt);
      document.getElementById('vote-hash').textContent = hash;
    }

    async function submitCommit() {
      if (!currentVoteChunkId) return;
      var voteValue = document.getElementById('vote-value-select').value;
      var reasonTag = document.getElementById('vote-reason-select').value;
      var salt = document.getElementById('vote-salt').value;
      var hash = await computeHash(voteValue, reasonTag, salt);

      try {
        // TODO: Uses deprecated chunk_id field -- migrate to changeset_id when formal vote API is updated
        var res = await API.post('/votes/formal/commit', {
          chunk_id: currentVoteChunkId,
          commit_hash: hash,
        });
        if (res.status === 201) {
          // Save vote data for reveal phase
          localStorage.setItem('aingram_vote_' + currentVoteChunkId, JSON.stringify({
            voteValue: parseInt(voteValue),
            reasonTag: reasonTag,
            salt: salt,
          }));
          closeCommitModal();
          showAlert(document.getElementById('review-chunks-container'), 'success', 'Vote committed. Reveal phase will open when the deadline passes.');
          loadReviewChunks();
        } else {
          showAlert(document.getElementById('review-chunks-container'), 'warning', (res.data && res.data.error) ? res.data.error.message : 'Commit failed');
        }
      } catch (err) {
        showAlert(document.getElementById('review-chunks-container'), 'warning', 'Commit failed. Are you logged in?');
      }
    }

    // ─── Reveal ─────────────────────────────────────────────────────

    async function revealVote(chunkId) {
      var saved = localStorage.getItem('aingram_vote_' + chunkId);
      if (!saved) { showAlert(document.getElementById('review-chunks-container'), 'warning', 'No saved vote data found for this chunk.'); return; }
      var data = JSON.parse(saved);

      try {
        // TODO: Uses deprecated chunk_id field -- migrate to changeset_id when formal vote API is updated
        var res = await API.post('/votes/formal/reveal', {
          chunk_id: chunkId,
          vote_value: data.voteValue,
          reason_tag: data.reasonTag,
          salt: data.salt,
        });
        if (res.status === 201) {
          localStorage.removeItem('aingram_vote_' + chunkId);
          showAlert(document.getElementById('review-chunks-container'), 'success', 'Vote revealed successfully.');
          loadReviewChunks();
        } else {
          showAlert(document.getElementById('review-chunks-container'), 'warning', (res.data && res.data.error) ? res.data.error.message : 'Reveal failed');
        }
      } catch (err) {
        showAlert(document.getElementById('review-chunks-container'), 'warning', 'Reveal failed.');
      }
    }

    // ─── Refresh mechanism ─────────────────────────────────────────

    var refreshFlagsByChunk = {};

    async function renderRefreshStatus(topic) {
      var bar = document.getElementById('refresh-status');
      if (!bar || topic.topic_type !== 'knowledge') return;

      // Show "Ask refresh" button for logged-in users (independent of flags fetch)
      var askBtn = document.getElementById('ask-refresh-btn');
      var currentUser = await getCurrentUser();
      if (askBtn && currentUser) {
        askBtn.classList.remove('s-5790ffba');
      }

      // Default status bar from topic data (no API call needed)
      if (topic.to_be_refreshed) {
        bar.className = 'refresh-status-bar refresh-needed';
        bar.innerHTML = '&#9888; Refresh needed';
        if (askBtn && currentUser) {
          askBtn.innerHTML = '&#10003; Refresh asked';
          askBtn.disabled = true;
          askBtn.classList.add('btn-disabled');
        }
      } else if (topic.last_refreshed_at) {
        bar.className = 'refresh-status-bar refresh-fresh';
        bar.innerHTML = '&#10003; Last verified ' + timeAgo(topic.last_refreshed_at) +
          (topic.refresh_check_count > 0 ? ' (' + topic.refresh_check_count + ' checks)' : '');
      } else {
        bar.className = 'refresh-status-bar refresh-never';
        bar.innerHTML = 'Never refreshed';
      }
      // Enrich with flag count (non-blocking)
      try {
        var flagRes = await API.get('/topics/' + topic.id + '/refresh-flags');
        if (flagRes.status === 200 && flagRes.data) {
          var flagCount = flagRes.data.count || 0;
          if (flagRes.data.flags) {
            flagRes.data.flags.forEach(function(g) {
              refreshFlagsByChunk[g.chunk_id] = g.flags.length;
            });
          }
          if (flagCount > 0 && topic.to_be_refreshed) {
            bar.innerHTML = '&#9888; Refresh needed &mdash; ' + flagCount + ' pending flag(s)';
          }
        }
      } catch (e) {
        // Non-critical
      }
    }


    function openRefreshFlagModal() {
      getCurrentUser().then(function(user) {
        if (!user) { alert('You must be logged in to request a refresh.'); return; }
        document.getElementById('refresh-flag-reason').value = '';
        document.getElementById('refresh-flag-error').innerHTML = '';
        document.getElementById('refresh-flag-success').innerHTML = '';
        document.getElementById('refresh-flag-modal').style.display = 'flex';
      });
    }

    // Ask refresh button + flag modal
    document.addEventListener('DOMContentLoaded', function() {
      // Attach click handler on the static Ask refresh button
      var askRefreshBtn = document.getElementById('ask-refresh-btn');
      if (askRefreshBtn) {
        askRefreshBtn.addEventListener('click', function() {
          if (!this.disabled) openRefreshFlagModal();
        });
      }

      var flagModal = document.getElementById('refresh-flag-modal');
      if (!flagModal) return;
      document.getElementById('flag-modal-close').addEventListener('click', function() {
        flagModal.style.display = 'none';
      });
      flagModal.addEventListener('click', function(e) {
        if (e.target === flagModal) flagModal.style.display = 'none';
      });

      document.getElementById('refresh-flag-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var reason = document.getElementById('refresh-flag-reason').value.trim();
        if (reason.length < 5) { document.getElementById('refresh-flag-error').innerHTML = '<div class="alert alert-warning">Reason must be at least 5 characters.</div>'; return; }

        // Flag all published chunks of the article
        try {
          var topicRes = await API.get('/topics/' + currentTopicId);
          var allChunks = ((topicRes.data || topicRes).chunks || []).filter(function(c) { return !c.article_summary && !c.discussion_summary; });
          if (allChunks.length === 0) {
            document.getElementById('refresh-flag-error').innerHTML = '<div class="alert alert-warning">No chunks found to flag.</div>';
            return;
          }

          var errors = 0;
          for (var i = 0; i < allChunks.length; i++) {
            var res = await API.post('/chunks/' + allChunks[i].id + '/refresh-flag', { reason: reason });
            if (res.status !== 201) errors++;
          }
          if (errors === 0) {
            document.getElementById('refresh-flag-success').innerHTML = '<div class="alert alert-success">Refresh requested.</div>';
            var askBtn2 = document.getElementById('ask-refresh-btn');
            if (askBtn2) { askBtn2.innerHTML = '&#10003; Refresh asked'; askBtn2.disabled = true; askBtn2.classList.add('btn-disabled'); }
            setTimeout(function() { flagModal.style.display = 'none'; location.reload(); }, 1200);
          } else {
            document.getElementById('refresh-flag-error').innerHTML = '<div class="alert alert-warning">' + errors + ' flag(s) failed.</div>';
          }
        } catch (err) {
          document.getElementById('refresh-flag-error').innerHTML = '<div class="alert alert-warning">Failed to submit refresh request.</div>';
        }
      });

      // Refresh article modal removed: refresh is now triggered via AI agent action
    });
