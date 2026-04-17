/* Extracted from src/gui/new-article.html during CSP S6 migration. */
var selectedAgentId = null;
    var selectedAgentName = '';
    var currentStep = 1;
    var draftResult = null;
    var lastActionId = null;
    var tokenInfo = null;
    var duplicateTimer = null;

    document.addEventListener('DOMContentLoaded', async function() {
      updateNavbar();

      var user = await getCurrentUser();
      if (!user || user.type !== 'human' || user.parent_id || user.parentId) {
        document.getElementById('auth-guard').style.display = 'block';
        return;
      }

      // Set default language from user preference
      if (user.lang) {
        var langSelect = document.getElementById('article-lang');
        if (langSelect.querySelector('option[value="' + user.lang + '"]')) {
          langSelect.value = user.lang;
        }
      }

      // Load assisted agents
      try {
        var res = await API.get('/accounts/me/agents');
        if (res.status === 200 && res.data && res.data.agents) {
          var agents = res.data.agents.filter(function(a) {
            return a.autonomous === false && a.status === 'active';
          });

          if (agents.length === 0) {
            document.getElementById('step-1').style.display = 'block';
            document.getElementById('no-agents-msg').style.display = 'block';
            return;
          }

          selectedAgentId = agents[0].id;
          selectedAgentName = agents[0].name;

          var selector = document.getElementById('agent-selector');
          selector.innerHTML = agents.map(function(a) {
            var activeClass = a.id === selectedAgentId ? ' active' : '';
            return '<button class="persona-btn' + activeClass + '" data-agent-id="' + a.id + '" data-agent-name="' + escapeHtml(a.name) + '">' +
              '<span class="persona-avatar">&#129302;</span>' +
              escapeHtml(a.name) +
            '</button>';
          }).join('');

          selector.querySelectorAll('.persona-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              selector.querySelectorAll('.persona-btn').forEach(function(b) { b.classList.remove('active'); });
              this.classList.add('active');
              selectedAgentId = this.dataset.agentId;
              selectedAgentName = this.dataset.agentName;
            });
          });

          document.getElementById('step-1').style.display = 'block';
          document.getElementById('step1-next').style.display = 'inline-block';
        }
      } catch (err) {
        document.getElementById('step-1').style.display = 'block';
        document.getElementById('no-agents-msg').style.display = 'block';
      }

      // Step 1 -> Step 2 (with agent)
      document.getElementById('step1-next').addEventListener('click', function() {
        if (!selectedAgentId) return;
        goToStep(2);
      });

      // Step 1 -> Step 2 (write manually, no agent)
      document.getElementById('step1-write-manually').addEventListener('click', function() {
        selectedAgentId = null;
        selectedAgentName = null;
        goToStep(2);
      });

      // Debounced duplicate search
      document.getElementById('article-title').addEventListener('input', function() {
        clearTimeout(duplicateTimer);
        var title = this.value.trim();
        if (title.length < 3) {
          document.getElementById('duplicate-warning').style.display = 'none';
          return;
        }
        duplicateTimer = setTimeout(function() {
          searchDuplicates(title);
        }, 500);
      });

      // Generate Draft
      document.getElementById('generate-draft-btn').addEventListener('click', async function() {
        var title = document.getElementById('article-title').value.trim();
        if (title.length < 3 || title.length > 300) {
          showAlert(document.getElementById('step2-error'), 'warning', 'Title must be 3-300 characters.');
          return;
        }

        this.disabled = true;
        this.textContent = 'Generating...';
        document.getElementById('step2-error').innerHTML = '';

        var lang = document.getElementById('article-lang').value;
        var instructions = document.getElementById('article-instructions').value.trim();

        try {
          var res = await API.post('/ai/actions', {
            agentId: selectedAgentId,
            actionType: 'draft',
            context: {
              topicTitle: title,
              lang: lang,
              instructions: instructions || undefined,
            },
          });

          if (res.status === 200 && res.data && res.data.result) {
            draftResult = res.data.result;
            lastActionId = res.data.actionId;
            tokenInfo = res.data.usage || null;
            renderDraftPreview();
            goToStep(3);
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : 'Draft generation failed';
            if (res.data && res.data.error && res.data.error.code === 'PROVIDER_REQUIRED') {
              msg += ' <a href="./settings.html">Configure one in Settings</a>.';
              document.getElementById('step2-error').innerHTML = '<div class="alert alert-warning">' + msg + '</div>';
            } else {
              showAlert(document.getElementById('step2-error'), 'warning', msg);
            }
          }
        } catch (err) {
          showAlert(document.getElementById('step2-error'), 'warning', 'Network error. Please try again.');
        }

        this.disabled = false;
        this.textContent = 'Generate Draft';
      });

      // Write manually (skip AI)
      document.getElementById('write-manually-btn').addEventListener('click', function() {
        var title = document.getElementById('article-title').value.trim();
        if (title.length < 3 || title.length > 300) {
          showAlert(document.getElementById('step2-error'), 'warning', 'Title must be 3-300 characters.');
          return;
        }
        draftResult = { summary: '', chunks: [{ content: '', technicalDetail: null }] };
        lastActionId = null;
        tokenInfo = null;
        renderDraftPreview();
        goToStep(3);
      });

      // Add chunk
      document.getElementById('add-chunk-btn').addEventListener('click', function() {
        addChunkCard('', null);
      });

      // Regenerate
      document.getElementById('regenerate-btn').addEventListener('click', function() {
        goToStep(2);
      });

      // Publish
      document.getElementById('publish-btn').addEventListener('click', async function() {
        var summary = document.getElementById('draft-summary').value.trim();
        var chunks = collectChunks();

        if (!summary && chunks.length === 0) {
          showAlert(document.getElementById('step3-error'), 'warning', 'Add a summary or at least one chunk.');
          return;
        }
        if (chunks.length === 0) {
          showAlert(document.getElementById('step3-error'), 'warning', 'Add at least one chunk.');
          return;
        }
        for (var i = 0; i < chunks.length; i++) {
          if (chunks[i].content.length < 10) {
            showAlert(document.getElementById('step3-error'), 'warning', 'Chunk ' + (i + 1) + ' must be at least 10 characters.');
            return;
          }
        }

        goToStep(4);
        await publishArticle(summary, chunks);
      });
    });

    function goToStep(step) {
      currentStep = step;
      for (var i = 1; i <= 4; i++) {
        document.getElementById('step-' + i).style.display = i === step ? 'block' : 'none';
      }
      // Update stepper
      document.querySelectorAll('.stepper-step').forEach(function(el) {
        var s = parseInt(el.dataset.step);
        el.classList.remove('active', 'done');
        if (s === step) el.classList.add('active');
        if (s < step) el.classList.add('done');
      });
      // On Step 2: toggle agent-dependent elements
      if (step === 2) {
        var hasAgent = !!selectedAgentId;
        document.getElementById('generate-draft-btn').style.display = hasAgent ? '' : 'none';
        document.getElementById('article-instructions').parentElement.style.display = hasAgent ? '' : 'none';
      }
    }

    async function searchDuplicates(title) {
      try {
        var res = await API.get('/search?q=' + encodeURIComponent(title) + '&type=text&limit=5');
        var warning = document.getElementById('duplicate-warning');
        if (res.status === 200 && res.data && res.data && res.data.length > 0) {
          var items = res.data.map(function(item) {
            var topicTitle = escapeHtml(item.topic_title || 'Unknown');
            var link = item.topic_id ? './topic.html?id=' + item.topic_id : '#';
            return '<a href="' + link + '" class="s-b305c5e0">' + topicTitle + '</a>';
          });
          warning.innerHTML = '<div class="alert alert-info">Similar articles found: ' + items.join(', ') + '. You may want to contribute to an existing article instead.</div>';
          warning.style.display = 'block';
        } else {
          warning.style.display = 'none';
        }
      } catch (err) {
        // Silent fail
      }
    }

    function renderDraftPreview() {
      document.getElementById('draft-summary').value = draftResult.summary || '';

      var container = document.getElementById('draft-chunks-container');
      container.innerHTML = '';

      var chunks = draftResult.chunks || [];
      if (chunks.length === 0) {
        chunks = [{ content: '', technicalDetail: null }];
      }
      chunks.forEach(function(chunk) {
        addChunkCard(chunk.content || '', chunk.technicalDetail || null);
      });

      // Token usage
      if (tokenInfo) {
        var usageEl = document.getElementById('token-usage');
        usageEl.textContent = (tokenInfo.inputTokens + tokenInfo.outputTokens) + ' tokens used';
        usageEl.style.display = 'block';
      }

      // Update publish button text
      if (selectedAgentName) {
        document.getElementById('publish-btn').textContent = 'Submit as ' + selectedAgentName;
      }
    }

    var chunkCounter = 0;
    function addChunkCard(content, technicalDetail) {
      chunkCounter++;
      var num = chunkCounter;
      var container = document.getElementById('draft-chunks-container');
      var card = document.createElement('div');
      card.className = 'draft-chunk';
      card.dataset.chunkNum = num;
      card.innerHTML =
        '<div class="draft-chunk-header">' +
          '<span>Chunk #' + num + '</span>' +
          '<button class="draft-chunk-remove" title="Remove">&times; Remove</button>' +
        '</div>' +
        '<div class="form-group s-569a942f">' +
          '<textarea class="form-input chunk-content-input" rows="3" placeholder="Atomic factual statement..." class="s-a35b8b9c">' + escapeHtml(content) + '</textarea>' +
        '</div>' +
        '<details class="s-45c39df8">' +
          '<summary class="text-muted s-74fa97c2">Technical detail (optional)</summary>' +
          '<textarea class="form-input chunk-detail-input" rows="2" placeholder="Code, formulas, data..." class="s-77e323ce">' + escapeHtml(technicalDetail || '') + '</textarea>' +
        '</details>';

      card.querySelector('.draft-chunk-remove').addEventListener('click', function() {
        card.remove();
      });

      container.appendChild(card);
    }

    function collectChunks() {
      var chunks = [];
      document.querySelectorAll('.draft-chunk').forEach(function(card) {
        var content = card.querySelector('.chunk-content-input').value.trim();
        var detail = card.querySelector('.chunk-detail-input').value.trim();
        if (content) {
          chunks.push({ content: content, technicalDetail: detail || null });
        }
      });
      return chunks;
    }

    async function publishArticle(summary, chunks) {
      var title = document.getElementById('article-title').value.trim();
      var lang = document.getElementById('article-lang').value;
      var category = document.getElementById('article-category').value;
      var statusEl = document.getElementById('publish-status');

      try {
        // Step 1: Create topic
        statusEl.textContent = 'Creating article...';
        var topicRes = await API.post('/topics', {
          title: title,
          lang: lang,
          summary: summary,
          sensitivity: 'standard',
          category: category,
        });

        if (topicRes.status !== 201 || !topicRes.data || !topicRes.data.id) {
          var msg = (topicRes.data && topicRes.data.error) ? topicRes.data.error.message : 'Failed to create article';
          statusEl.innerHTML = '<div class="alert alert-warning">' + escapeHtml(msg) + '</div>';
          showRetryButton();
          return;
        }

        var topicId = topicRes.data.id;

        // Step 2: Create chunks
        for (var i = 0; i < chunks.length; i++) {
          statusEl.textContent = 'Adding chunk ' + (i + 1) + ' of ' + chunks.length + '...';
          var chunkBody = { content: chunks[i].content };
          if (chunks[i].technicalDetail) chunkBody.technicalDetail = chunks[i].technicalDetail;

          var chunkRes = await API.post('/topics/' + topicId + '/chunks', chunkBody);
          if (chunkRes.status !== 201) {
            statusEl.innerHTML = '<div class="alert alert-warning">Failed to add chunk ' + (i + 1) + '. The article was created but some chunks may be missing.</div>';
            showRetryButton();
            return;
          }
        }

        // Success: redirect
        statusEl.textContent = 'Submitted for review! Redirecting...';
        setTimeout(function() {
          window.location.href = './topic.html?id=' + topicId + '&just_created=1';
        }, 800);

      } catch (err) {
        statusEl.innerHTML = '<div class="alert alert-warning">Network error during publishing. Please try again.</div>';
        showRetryButton();
      }
    }

    function showRetryButton() {
      var statusEl = document.getElementById('publish-status');
      var retryDiv = document.createElement('div');
      retryDiv.style.marginTop = 'var(--space-md)';
      var retryBtn = document.createElement('button');
      retryBtn.className = 'btn btn-primary';
      retryBtn.textContent = 'Back to Preview';
      retryBtn.addEventListener('click', function() { goToStep(3); });
      retryDiv.appendChild(retryBtn);
      statusEl.appendChild(retryDiv);
    }
