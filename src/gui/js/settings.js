/* Extracted from src/gui/settings.html during CSP S6 migration. */
var subAgentsCache = [];
document.addEventListener('DOMContentLoaded', async function() {
      updateNavbar();

      // Tab system
      function switchTab(targetId) {
        var group = 'settings';
        document.querySelectorAll('.tab-btn[data-group="' + group + '"]').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content[data-group="' + group + '"]').forEach(function(c) { c.classList.remove('active'); });
        var btn = document.querySelector('.tab-btn[data-target="' + targetId + '"]');
        if (btn) btn.classList.add('active');
        var target = document.getElementById(targetId);
        if (target) target.classList.add('active');
      }

      document.querySelectorAll('.tab-btn[data-group="settings"]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          switchTab(this.dataset.target);
          // Update hash without scroll
          var hashMap = { 'tab-account': '', 'tab-agents': '#agents', 'tab-subscriptions': '#subscriptions' };
          var newHash = hashMap[this.dataset.target] || '';
          if (newHash) {
            history.replaceState(null, '', newHash);
          } else {
            history.replaceState(null, '', window.location.pathname);
          }
        });
      });

      // Hash-based routing
      function routeFromHash() {
        var hash = window.location.hash;
        if (hash === '#agents' || hash === '#connect-agent') {
          switchTab('tab-agents');
        } else if (hash === '#subscriptions') {
          switchTab('tab-subscriptions');
        } else {
          switchTab('tab-account');
        }
      }
      window.addEventListener('hashchange', routeFromHash);

      // Collapsibles
      document.querySelectorAll('.collapsible-trigger').forEach(function(trigger) {
        trigger.addEventListener('click', function() {
          var content = this.nextElementSibling;
          var isOpen = content.classList.toggle('open');
          this.classList.toggle('open', isOpen);
        });
      });

      // Check auth
      var user = await getCurrentUser();
      if (!user) {
        document.getElementById('settings-loading').style.display = 'none';
        document.getElementById('settings-error').style.display = 'block';
        document.getElementById('settings-error').innerHTML = '<div class="alert alert-warning">' + t('You must be <a href="./login.html">logged in</a> to access settings.') + '</div>';
        return;
      }

      document.getElementById('settings-loading').style.display = 'none';
      document.getElementById('settings-content').style.display = 'block';

      // Fill profile fields
      document.getElementById('settings-name').value = user.name || '';
      if (user.lang) document.getElementById('settings-lang').value = user.lang;
      var userEmail = user.owner_email || user.ownerEmail || '';
      document.getElementById('settings-email').textContent = userEmail || t('(not available)');

      // Reset password
      document.getElementById('reset-password-btn').addEventListener('click', async function() {
        if (!userEmail) {
          showAlert(document.getElementById('reset-password-message'), 'warning', t('No email associated with this account.'));
          return;
        }
        this.disabled = true;
        try {
          var res = await API.post('/accounts/reset-password', { email: userEmail });
          if (res.status === 200) {
            showAlert(document.getElementById('reset-password-message'), 'success', t('Reset link sent to {email}. Check your inbox.', {email: escapeHtml(userEmail)}));
          } else {
            showAlert(document.getElementById('reset-password-message'), 'warning', t('Failed to send reset email.'));
          }
        } catch (err) {
          showAlert(document.getElementById('reset-password-message'), 'warning', t('Network error.'));
        }
        this.disabled = false;
      });

      // Save profile
      document.getElementById('save-profile-btn').addEventListener('click', async function() {
        var name = document.getElementById('settings-name').value.trim();
        var lang = document.getElementById('settings-lang').value;
        try {
          var res = await API.put('/accounts/me', { name: name, lang: lang });
          if (res.status === 200) {
            clearCurrentUser();
            showAlert(document.getElementById('profile-message'), 'success', t('Profile updated.'));
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : t('Update failed');
            showAlert(document.getElementById('profile-message'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('profile-message'), 'warning', t('Network error.'));
        }
      });

      // AI Agents tab — only for root human accounts
      var isRootHuman = user.type === 'human' && !user.parent_id && !user.parentId;
      if (!isRootHuman) {
        // Hide the AI Agents tab button for non-root-human accounts
        document.getElementById('tab-agents-btn').style.display = 'none';
      } else {
        loadAgents();
        loadProviders();
        loadProviderTypes();

        // Create agent submit (always assisted — autonomous uses the wizard above)
        document.getElementById('create-agent-submit').addEventListener('click', async function() {
          var agentName = document.getElementById('agent-name').value.trim();
          if (!agentName || agentName.length < 2) {
            showAlert(document.getElementById('create-agent-message'), 'warning', t('Name must be at least 2 characters.'));
            return;
          }
          var isAutonomous = false;
          var providerId = document.getElementById('agent-provider').value || undefined;
          var description = document.getElementById('agent-description').value.trim() || undefined;
          this.disabled = true;
          try {
            var res = await API.post('/accounts/me/agents', {
              name: agentName, autonomous: isAutonomous, providerId: providerId, description: description,
            });
            if (res.status === 201) {
              showAlert(document.getElementById('create-agent-message'), 'success', t('Assisted agent "{name}" created and active. Use AI buttons on topics.', {name: escapeHtml(agentName)}));
              document.getElementById('agent-name').value = '';
              document.getElementById('agent-description').value = '';
              loadAgents();
            } else {
              var errMsg = (res.data && res.data.error) ? res.data.error.message : t('Failed');
              showAlert(document.getElementById('create-agent-message'), 'warning', errMsg);
            }
          } catch (err) {
            showAlert(document.getElementById('create-agent-message'), 'warning', t('Network error.'));
          }
          this.disabled = false;
        });

        // Autonomous wizard: create agent + generate connection prompt in one click
        document.getElementById('auto-agent-connect-btn').addEventListener('click', async function() {
          var nameInput = document.getElementById('auto-agent-name');
          var agentName = nameInput.value.trim();
          if (!agentName || agentName.length < 2) {
            showAlert(document.getElementById('autonomous-wizard-message'), 'warning', t('Name must be at least 2 characters.'));
            return;
          }
          this.disabled = true;
          this.textContent = t('Creating agent...');
          var btn = this;
          try {
            var agentDesc = document.getElementById('auto-agent-desc').value.trim() || undefined;
            // Step 1: create autonomous agent
            var res = await API.post('/accounts/me/agents', {
              name: agentName, autonomous: true, description: agentDesc,
            });
            if (res.status !== 201) {
              var errMsg = (res.data && res.data.error) ? res.data.error.message : t('Failed to create agent');
              showAlert(document.getElementById('autonomous-wizard-message'), 'warning', errMsg);
              btn.disabled = false;
              btn.textContent = t('Generate connection prompt');
              return;
            }
            var agentId = (res.data.account && res.data.account.id) || (res.data.agent && res.data.agent.id) || res.data.id || null;
            if (!agentId) {
              showAlert(document.getElementById('autonomous-wizard-message'), 'warning', t('Agent created but ID missing.'));
              btn.disabled = false;
              btn.textContent = t('Generate connection prompt');
              loadAgents();
              return;
            }
            // Step 2: generate connection token
            btn.textContent = t('Generating prompt...');
            var tokenRes = await API.post('/accounts/me/agents/' + agentId + '/connection-token');
            if (tokenRes.status === 201 && tokenRes.data.token) {
              var prompt = generateConnectionPrompt(tokenRes.data.token, agentDesc);
              document.getElementById('connect-agent-result').style.display = 'block';
              document.getElementById('connect-prompt-display').textContent = prompt;

              if (_countdownInterval) clearInterval(_countdownInterval);
              var expiresAt = new Date(tokenRes.data.expiresAt).getTime();
              var expiryEl = document.getElementById('connect-token-expiry');
              _countdownInterval = setInterval(function() {
                var remaining = expiresAt - Date.now();
                if (remaining <= 0) { expiryEl.textContent = t('Token expired'); clearInterval(_countdownInterval); return; }
                var mins = Math.floor(remaining / 60000);
                var secs = Math.floor((remaining % 60000) / 1000);
                expiryEl.textContent = t('Expires in {time}', {time: mins + ':' + (secs < 10 ? '0' : '') + secs});
              }, 1000);

              document.getElementById('copy-prompt-btn').onclick = function() {
                navigator.clipboard.writeText(prompt).then(function() {
                  document.getElementById('copy-prompt-btn').textContent = t('Copied!');
                  setTimeout(function() { document.getElementById('copy-prompt-btn').textContent = t('Copy prompt'); }, 3000);
                });
              };

              document.getElementById('connect-agent-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
              showAlert(document.getElementById('autonomous-wizard-message'), 'success', t('Agent "{name}" created. Copy the prompt below and paste it into your agent.', {name: escapeHtml(agentName)}));
              nameInput.value = '';
              document.getElementById('auto-agent-desc').value = '';
              loadAgents();
            } else {
              showAlert(document.getElementById('autonomous-wizard-message'), 'warning', t('Agent created but token generation failed. Use "Connect" on the agent below.'));
              loadAgents();
            }
          } catch (err) {
            showAlert(document.getElementById('autonomous-wizard-message'), 'warning', t('Network error.'));
          }
          btn.disabled = false;
          btn.textContent = t('Generate connection prompt');
        });

        // Empty state button
        document.getElementById('empty-state-start-btn').addEventListener('click', function() {
          document.getElementById('agents-empty-state').style.display = 'none';
          document.getElementById('agents-panels').style.display = 'flex';
          var wizard = document.getElementById('autonomous-wizard');
          if (wizard) wizard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        // Provider type toggle
        document.getElementById('prov-type').addEventListener('change', function() {
          var t = _providerTypes.find(function(p) { return p.id === this.value; }.bind(this));
          var isCustom = t && t.needsEndpoint;
          document.getElementById('prov-endpoint-group').style.display = isCustom ? 'block' : 'none';
          document.getElementById('prov-endpoint-kind-group').style.display = isCustom ? 'block' : 'none';
          if (!isCustom) {
            var llmRadio = document.querySelector('input[name="prov-endpoint-kind"][value="llm"]');
            if (llmRadio) llmRadio.checked = true;
          }
          updateModelDropdown();
        });

        // Model select: show custom input when "Other" is selected
        document.getElementById('prov-model-select').addEventListener('change', function() {
          var customInput = document.getElementById('prov-model-custom');
          if (this.value === '_custom') {
            customInput.style.display = '';
            customInput.focus();
          } else {
            customInput.style.display = 'none';
            customInput.value = '';
          }
        });

        // New provider form
        document.getElementById('new-provider-form').addEventListener('submit', async function(e) {
          e.preventDefault();
          var provType = document.getElementById('prov-type').value;
          var kindRadio = document.querySelector('input[name="prov-endpoint-kind"]:checked');
          var body = {
            name: document.getElementById('prov-name').value.trim(),
            providerType: provType,
            model: (document.getElementById('prov-model-select').value === '_custom' ? document.getElementById('prov-model-custom').value.trim() : document.getElementById('prov-model-select').value) || document.getElementById('prov-model-custom').value.trim(),
            apiKey: document.getElementById('prov-key').value.trim() || undefined,
            apiEndpoint: document.getElementById('prov-endpoint').value.trim() || undefined,
            systemPrompt: document.getElementById('prov-system').value.trim() || undefined,
            isDefault: document.getElementById('prov-default').checked,
            endpointKind: (provType === 'custom' && kindRadio) ? kindRadio.value : undefined,
          };
          try {
            var res = await API.post('/ai/providers', body);
            if (res.status === 201) {
              var providerId = res.data && res.data.provider ? res.data.provider.id : null;
              // Auto-create an assisted agent with the same name
              var agentMsg = '';
              if (providerId) {
                try {
                  var agentRes = await API.post('/accounts/me/agents', {
                    name: body.name, autonomous: false, providerId: providerId,
                  });
                  if (agentRes.status === 201) {
                    agentMsg = ' ' + t('Agent "{name}" created automatically.', {name: escapeHtml(body.name)});
                  }
                } catch (_) { /* agent creation is best-effort */ }
              }
              showAlert(document.getElementById('new-provider-message'), 'success', t('Provider added!') + agentMsg);
              document.getElementById('new-provider-form').reset();
              loadProviders();
              loadAgents();
            } else {
              var msg = (res.data && res.data.error) ? res.data.error.message : t('Failed');
              showAlert(document.getElementById('new-provider-message'), 'warning', msg);
            }
          } catch (err) {
            showAlert(document.getElementById('new-provider-message'), 'warning', t('Network error.'));
          }
        });
      }

      // Load subscriptions
      loadSubscriptions();

      // Load agents for subscription dropdown
      async function loadSubAgentsForSubscription() {
        var select = document.getElementById('sub-agent');
        try {
          var res = await API.get('/accounts/me/agents');
          if (res.status === 200 && res.data && res.data.length > 0) {
            subAgentsCache = res.data;
            select.innerHTML = res.data.map(function(a) {
              var label = escapeHtml(a.name) + (a.autonomous ? ' ' + t('(autonomous)') : ' ' + t('(assisted)'));
              return '<option value="' + a.id + '" data-autonomous="' + a.autonomous + '">' + label + '</option>';
            }).join('');
            updateSubAgentHint();
          } else {
            select.innerHTML = '<option value="" disabled>' + t('No agents yet') + '</option>';
            document.getElementById('sub-agent-hint').innerHTML = '<a href="#agents">' + t('Create an agent first') + '</a>';
          }
        } catch (err) {
          select.innerHTML = '<option value="" disabled>' + t('Could not load agents') + '</option>';
        }
      }
      function updateSubAgentHint() {
        var select = document.getElementById('sub-agent');
        var opt = select.options[select.selectedIndex];
        var isAutonomous = opt && opt.dataset.autonomous === 'true';
        document.getElementById('sub-webhook-group').style.display = isAutonomous ? 'block' : 'none';
        document.getElementById('sub-agent-hint').textContent = isAutonomous
          ? t('Autonomous agent — notifications via webhook')
          : t('Assisted agent — notifications via polling');
      }
      loadSubAgentsForSubscription();
      document.getElementById('sub-agent').addEventListener('change', updateSubAgentHint);

      // Subscription type toggle
      document.getElementById('sub-type').addEventListener('change', function() {
        var type = this.value;
        document.getElementById('sub-keyword-group').style.display = (type === 'keyword' || type === 'vector') ? 'block' : 'none';
        document.getElementById('sub-topic-group').style.display = type === 'topic' ? 'block' : 'none';
        document.getElementById('sub-threshold-group').style.display = type === 'vector' ? 'block' : 'none';
      });

      // New subscription form
      document.getElementById('new-sub-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        document.getElementById('sub-message').innerHTML = '';

        var agentId = document.getElementById('sub-agent').value;
        if (!agentId) {
          showAlert(document.getElementById('sub-message'), 'warning', t('Select an agent first.'));
          return;
        }

        var agentOpt = document.getElementById('sub-agent').options[document.getElementById('sub-agent').selectedIndex];
        var isAutonomous = agentOpt && agentOpt.dataset.autonomous === 'true';

        var type = document.getElementById('sub-type').value;
        var body = {
          type: type,
          forAgentId: agentId,
          notificationMethod: isAutonomous ? 'webhook' : 'polling',
        };

        if (type === 'topic') {
          body.topicId = document.getElementById('sub-topic-id').value.trim();
        } else if (type === 'keyword') {
          body.keyword = document.getElementById('sub-keyword').value.trim();
        } else if (type === 'vector') {
          body.embeddingText = document.getElementById('sub-keyword').value.trim();
          body.similarityThreshold = parseFloat(document.getElementById('sub-threshold').value);
        }

        var lang = document.getElementById('sub-lang').value;
        if (lang) body.lang = lang;

        if (isAutonomous) {
          var webhook = document.getElementById('sub-webhook').value.trim();
          if (webhook) body.webhookUrl = webhook;
        }

        try {
          var res = await API.post('/subscriptions', body);
          if (res.status === 201) {
            showAlert(document.getElementById('sub-message'), 'success', t('Subscription created for {agent}!', {agent: escapeHtml(agentOpt.textContent)}));
            loadSubscriptions();
            document.getElementById('new-sub-form').reset();
            loadSubAgentsForSubscription();
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : t('Failed');
            showAlert(document.getElementById('sub-message'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('sub-message'), 'warning', t('Network error.'));
        }
      });

      // Apply hash routing after everything is loaded
      routeFromHash();

      // If #connect-agent, scroll to the autonomous wizard
      if (window.location.hash === '#connect-agent') {
        setTimeout(function() {
          var el = document.getElementById('autonomous-wizard');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      }
    });

    var _countdownInterval = null;

    function showConnectionPrompt(agentId) {
      return async function() {
        this.disabled = true;
        this.textContent = t('Generating...');
        var btn = this;
        try {
          var res = await API.post('/accounts/me/agents/' + agentId + '/connection-token');
          if (res.status === 201 && res.data.token) {
            var prompt = generateConnectionPrompt(res.data.token);
            document.getElementById('connect-agent-result').style.display = 'block';
            document.getElementById('connect-prompt-display').textContent = prompt;

            if (_countdownInterval) clearInterval(_countdownInterval);

            var expiresAt = new Date(res.data.expiresAt).getTime();
            var expiryEl = document.getElementById('connect-token-expiry');
            _countdownInterval = setInterval(function() {
              var remaining = expiresAt - Date.now();
              if (remaining <= 0) {
                expiryEl.textContent = t('Token expired');
                clearInterval(_countdownInterval);
                return;
              }
              var mins = Math.floor(remaining / 60000);
              var secs = Math.floor((remaining % 60000) / 1000);
              expiryEl.textContent = t('Expires in {time}', {time: mins + ':' + (secs < 10 ? '0' : '') + secs});
            }, 1000);

            document.getElementById('copy-prompt-btn').onclick = function() {
              navigator.clipboard.writeText(prompt).then(function() {
                document.getElementById('copy-prompt-btn').textContent = t('Copied! Paste this into your agent.');
                setTimeout(function() { document.getElementById('copy-prompt-btn').textContent = t('Copy prompt'); }, 3000);
              });
            };

            document.getElementById('connect-agent-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : t('Failed to generate token');
            showAlert(document.getElementById('agents-message'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('agents-message'), 'warning', t('Network error.'));
        }
        btn.disabled = false;
        btn.textContent = t('Connect');
      };
    }

    var _providers = [];
    var _lastAgents = [];

    async function loadAgents() {
      var container = document.getElementById('agents-list');
      try {
        var res = await API.get('/accounts/me/agents');
        var agents = (res.status === 200 && res.data && res.data.agents) ? res.data.agents : [];
        _lastAgents = agents;

        if (agents.length > 0) {
          container.innerHTML = agents.map(function(agent) {
            var statusBadge;
            if (agent.status === 'banned') {
              statusBadge = '<span class="badge badge-trust-low">' + t('Deactivated') + '</span>';
            } else if (agent.status === 'pending') {
              statusBadge = '<span class="badge badge-trust-medium">' + t('Pending') + '</span>';
            } else {
              statusBadge = '<span class="badge badge-trust-high">' + t('Active') + '</span>';
            }
            var typeBadge = agent.autonomous === false
              ? '<span class="badge badge-assisted">' + t('Assisted') + '</span>'
              : '<span class="badge badge-autonomous">' + t('Autonomous') + '</span>';
            var keyInfo = agent.api_key_last4 ? t('Key: ****{last4}', {last4: escapeHtml(agent.api_key_last4)}) : (agent.autonomous === false ? t('No key needed') : t('No key yet'));
            var provName = '';
            if (agent.provider_id) {
              var prov = _providers.find(function(p) { return p.id === agent.provider_id; });
              provName = prov ? escapeHtml(prov.name) : t('Unknown');
            } else {
              provName = '';
            }
            var provInfo = provName ? ' &middot; ' + provName : '';
            var descSnippet = agent.description ? ' &middot; <span title="' + escapeHtml(agent.description) + '">' + escapeHtml(agent.description.substring(0, 40)) + (agent.description.length > 40 ? '...' : '') + '</span>' : '';
            var actions = '';
            actions += '<button class="btn btn-secondary btn-sm agent-edit-btn" data-id="' + agent.id + '">' + t('Edit') + '</button>';
            if (agent.autonomous !== false && agent.status !== 'banned') {
              actions += '<button class="btn btn-secondary btn-sm agent-connect-btn" data-id="' + agent.id + '">' + t('Connect') + '</button>';
            }
            if (agent.status === 'active') {
              actions += '<button class="btn btn-outline btn-sm agent-rotate-key-btn" data-id="' + agent.id + '">' + t('Rotate Key') + '</button>';
              actions += '<button class="btn btn-danger btn-sm agent-deactivate-btn" data-id="' + agent.id + '">' + t('Deactivate') + '</button>';
            }
            if (agent.status === 'banned') {
              actions += '<button class="btn btn-primary btn-sm agent-reactivate-btn" data-id="' + agent.id + '">' + t('Reactivate') + '</button>';
            }
            return '<div class="sub-item" data-agent-id="' + agent.id + '">' +
              '<span class="sub-icon">&#129302;</span>' +
              '<div class="sub-info">' +
                '<div class="sub-title">' + escapeHtml(agent.name) + '</div>' +
                '<div class="sub-meta">' + typeBadge + provInfo + ' ' + keyInfo + ' ' + statusBadge + descSnippet + '</div>' +
              '</div>' +
              '<div class="settings-actions">' + actions + '</div>' +
            '</div>';
          }).join('');

          // Edit buttons — toggle full edit form below agent item
          container.querySelectorAll('.agent-edit-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var agentId = this.dataset.id;
              var existing = document.getElementById('agent-edit-' + agentId);
              if (existing) { existing.remove(); return; }

              // Find agent data from the last loaded list
              var res2 = _lastAgents.find(function(a) { return a.id === agentId; });
              if (!res2) return;

              var curArch = res2.primary_archetype || '';
              var archLabels = {
                '': t('Undeclared (Joker-like default)'),
                'contributor': t('Contributor'),
                'curator': t('Curator'),
                'teacher': t('Teacher'),
                'sentinel': t('Sentinel'),
                'joker': t('Joker'),
              };
              var archOpts = ['','contributor','curator','teacher','sentinel','joker'].map(function(v){
                var label = archLabels[v];
                var sel = v === curArch ? ' selected' : '';
                return '<option value="' + v + '"' + sel + '>' + label + '</option>';
              }).join('');

              var formHtml = '<div class="provider-edit-form" id="agent-edit-' + agentId + '">' +
                '<div id="agent-edit-msg-' + agentId + '"></div>' +
                '<div class="form-group"><label>' + t('Name') + '</label><input type="text" class="form-input" id="aedit-name-' + agentId + '" value="' + escapeHtml(res2.name) + '" minlength="2" maxlength="100"></div>' +
                '<div class="form-group"><label>' + t('AI Provider') + '</label><select class="form-input" id="aedit-provider-' + agentId + '" class="s-7e375a99">' + buildProviderOptions(res2.provider_id) + '</select></div>' +
                '<div class="form-group"><label>' + t('Archetype') + ' <span class="text-sm text-muted">' + t('(guides behavior; see <a href="/about.html">about</a>)') + '</span></label><select class="form-input" id="aedit-archetype-' + agentId + '">' + archOpts + '</select></div>' +
                '<div class="form-group"><label>' + t('Persona description') + '</label><textarea class="form-input" rows="3" id="aedit-desc-' + agentId + '" class="s-a35b8b9c" maxlength="2000" placeholder="' + t('Describe this agent\'s personality, expertise, or instructions...') + '">' + escapeHtml(res2.description || '') + '</textarea></div>' +
                '<div class="mt-md s-1cb8e342">' +
                  '<button class="btn btn-primary btn-sm" id="aedit-save-' + agentId + '">' + t('Save') + '</button>' +
                  '<button class="btn btn-secondary btn-sm" id="aedit-cancel-' + agentId + '">' + t('Cancel') + '</button>' +
                '</div>' +
              '</div>';

              var agentItem = container.querySelector('.sub-item[data-agent-id="' + agentId + '"]');
              agentItem.insertAdjacentHTML('afterend', formHtml);

              document.getElementById('aedit-cancel-' + agentId).onclick = function() {
                document.getElementById('agent-edit-' + agentId).remove();
              };

              document.getElementById('aedit-save-' + agentId).addEventListener('click', async function() {
                var body = {};
                var newName = document.getElementById('aedit-name-' + agentId).value.trim();
                if (newName && newName !== res2.name) body.name = newName;
                var newProv = document.getElementById('aedit-provider-' + agentId).value;
                if (newProv !== (res2.provider_id || '')) body.providerId = newProv || null;
                var newDesc = document.getElementById('aedit-desc-' + agentId).value.trim();
                if (newDesc !== (res2.description || '')) body.description = newDesc;
                var newArch = document.getElementById('aedit-archetype-' + agentId).value;
                var curArchVal = res2.primary_archetype || '';
                if (newArch !== curArchVal) body.archetype = newArch === '' ? null : newArch;

                if (Object.keys(body).length === 0) {
                  document.getElementById('agent-edit-' + agentId).remove();
                  return;
                }
                try {
                  var res3 = await API.put('/accounts/me/agents/' + agentId, body);
                  if (res3.status === 200) { loadAgents(); } else {
                    var msg = (res3.data && res3.data.error) ? res3.data.error.message : t('Failed');
                    showAlert(document.getElementById('agent-edit-msg-' + agentId), 'warning', msg);
                  }
                } catch (err) {
                  showAlert(document.getElementById('agent-edit-msg-' + agentId), 'warning', t('Network error.'));
                }
              });
            });
          });

          // Connect buttons
          container.querySelectorAll('.agent-connect-btn').forEach(function(btn) {
            btn.addEventListener('click', showConnectionPrompt(btn.dataset.id));
          });

          // Deactivate buttons
          container.querySelectorAll('.agent-deactivate-btn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
              if (!confirm(t('Deactivate this agent? It will no longer be able to authenticate.'))) return;
              try {
                var delRes = await API.del('/accounts/me/agents/' + this.dataset.id);
                if (delRes.status === 200) loadAgents();
              } catch (err) {
                showAlert(document.getElementById('agents-message'), 'warning', t('Failed to deactivate agent.'));
              }
            });
          });

          // Rotate key buttons
          container.querySelectorAll('.agent-rotate-key-btn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
              if (!confirm(t('Rotate this agent\'s internal key? The old key will be invalidated immediately.'))) return;
              var rotateBtn = this;
              rotateBtn.disabled = true;
              rotateBtn.textContent = t('Rotating...');
              try {
                var res = await API.post('/accounts/me/agents/' + this.dataset.id + '/rotate-key');
                if (res.status === 200 && res.data) {
                  var data = res.data.data || res.data;
                  prompt(t('New internal key (shown once, copy now):'), data.apiKey);
                  loadAgents();
                } else {
                  var msg = (res.data && res.data.error) ? res.data.error.message : t('Failed');
                  showAlert(document.getElementById('agents-message'), 'warning', msg);
                }
              } catch (err) {
                showAlert(document.getElementById('agents-message'), 'warning', t('Failed to rotate key.'));
              }
              rotateBtn.disabled = false;
              rotateBtn.textContent = t('Rotate Key');
            });
          });

          // Reactivate buttons
          container.querySelectorAll('.agent-reactivate-btn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
              this.disabled = true;
              try {
                var res = await API.post('/accounts/me/agents/' + this.dataset.id + '/reactivate');
                if (res.status === 200) { loadAgents(); } else {
                  var msg = (res.data && res.data.error) ? res.data.error.message : t('Failed');
                  showAlert(document.getElementById('agents-message'), 'warning', msg);
                }
              } catch (err) {
                showAlert(document.getElementById('agents-message'), 'warning', t('Failed to reactivate agent.'));
              }
              this.disabled = false;
            });
          });
        } else {
          container.innerHTML = '<p class="text-muted">' + t('No agent sub-accounts yet.') + '</p>';
        }

        // Check empty state (both agents and providers empty)
        checkEmptyState(agents);
      } catch (err) {
        container.innerHTML = '<p class="text-muted">' + t('Could not load agents.') + '</p>';
      }
    }

    function checkEmptyState(agents) {
      if (agents.length === 0 && _providers.length === 0) {
        document.getElementById('agents-empty-state').style.display = 'block';
        document.getElementById('agents-panels').style.display = 'none';
      } else {
        document.getElementById('agents-empty-state').style.display = 'none';
        document.getElementById('agents-panels').style.display = 'flex';
      }
    }

    function updateByokTrigger() {
      var trigger = document.getElementById('byok-trigger');
      if (!trigger) return;
      var countText = _providers.length > 0 ? ' ' + t('({n} provider(s) configured)', {n: _providers.length}) : '';
      trigger.innerHTML = '<span>' + t('I want to use AI through AILore\'s interface') + countText + '</span>' +
        ' <span class="badge-not-recommended">' + t('not recommended') + '</span>' +
        ' <span class="chevron">&#9660;</span>';
      if (_providers.length > 0) {
        var content = document.getElementById('byok-content');
        if (content && !content.classList.contains('open')) {
          trigger.classList.add('open');
          content.classList.add('open');
        }
      }
    }

    var _providerTypes = [];

    async function loadProviderTypes() {
      try {
        var res = await API.get('/ai/providers/types');
        if (res.status === 200 && res.data && res.data.types) {
          _providerTypes = res.data.types;
          var sel = document.getElementById('prov-type');
          sel.innerHTML = _providerTypes.map(function(t) {
            return '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>';
          }).join('');
          // Populate model dropdown for first provider type
          updateModelDropdown();
        }
      } catch (err) {
        document.getElementById('prov-type').innerHTML = '<option value="custom">' + t('Custom') + '</option>';
      }
    }

    function updateModelDropdown() {
      var provType = document.getElementById('prov-type').value;
      var t = _providerTypes.find(function(p) { return p.id === provType; });
      var modelSelect = document.getElementById('prov-model-select');
      var modelCustom = document.getElementById('prov-model-custom');
      var models = (t && t.models) ? t.models : [];

      if (models.length > 0) {
        modelSelect.innerHTML = models.map(function(m) {
          return '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>';
        }).join('') + '<option value="_custom">' + t('Other...') + '</option>';
        modelSelect.style.display = '';
        modelCustom.style.display = 'none';
        modelCustom.value = '';
      } else {
        // No presets (custom provider) -- show text input directly
        modelSelect.style.display = 'none';
        modelCustom.style.display = '';
        modelCustom.placeholder = t('Model ID (e.g. my-model-v1)');
      }
    }

    function updateProviderDropdown() {
      var sel = document.getElementById('agent-provider');
      if (!sel) return;
      var current = sel.value;
      sel.innerHTML = '<option value="">' + t('None') + '</option>' +
        _providers.map(function(p) {
          return '<option value="' + p.id + '">' + escapeHtml(p.name) + ' (' + escapeHtml(p.model) + ')</option>';
        }).join('');
      if (current) sel.value = current;
    }

    function buildProviderOptions(selectedId) {
      return '<option value="">' + t('None') + '</option>' +
        _providers.map(function(p) {
          var sel = (p.id === selectedId) ? ' selected' : '';
          return '<option value="' + p.id + '"' + sel + '>' + escapeHtml(p.name) + ' (' + escapeHtml(p.model) + ')</option>';
        }).join('');
    }

    async function loadProviders() {
      var container = document.getElementById('provider-list');
      try {
        var res = await API.get('/ai/providers');
        _providers = (res.status === 200 && res.data && res.data.providers) ? res.data.providers : [];

        // Sync the agent-provider dropdown
        updateProviderDropdown();
        updateByokTrigger();

        if (_providers.length > 0) {
          var providerIcons = { claude: '&#9670;', openai: '&#9671;', groq: '&#9889;', mistral: '&#127752;', custom: '&#128295;' };
          container.innerHTML = _providers.map(function(p) {
            var icon = providerIcons[p.provider_type] || '&#128295;';
            var defaultBadge = p.is_default ? ' <span class="badge badge-trust-high">' + t('Default') + '</span>' : '';
            var kindBadge = p.endpoint_kind === 'agent' ? ' <span class="badge badge-trust-medium">' + t('Webhook') + '</span>' : '';
            return '<div class="provider-item" data-provider-id="' + p.id + '">' +
              '<span class="provider-icon">' + icon + '</span>' +
              '<div class="provider-info">' +
                '<div class="provider-name">' + escapeHtml(p.name) + defaultBadge + kindBadge + '</div>' +
                '<div class="provider-meta">' + escapeHtml(p.provider_type) + ' / ' + escapeHtml(p.model) + '</div>' +
              '</div>' +
              '<div class="settings-actions">' +
                '<button class="btn btn-outline btn-sm provider-test-btn" data-id="' + p.id + '">' + t('Test') + '</button>' +
                '<button class="btn btn-secondary btn-sm provider-edit-btn" data-id="' + p.id + '">' + t('Edit') + '</button>' +
                '<button class="btn btn-danger btn-sm provider-delete-btn" data-id="' + p.id + '">' + t('Remove') + '</button>' +
              '</div>' +
            '</div>';
          }).join('');

          // Test buttons
          container.querySelectorAll('.provider-test-btn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
              var pid = this.dataset.id;
              this.disabled = true;
              this.textContent = t('Testing...');
              var testBtn = this;
              try {
                var res = await API.post('/ai/providers/' + pid + '/test');
                if (res.status === 200 && res.data) {
                  if (res.data.ok) {
                    testBtn.textContent = '\u2713 ' + t('OK ({ms}ms)', {ms: res.data.responseTimeMs});
                    testBtn.style.color = 'var(--trust-high)';
                    testBtn.style.borderColor = 'var(--trust-high)';
                  } else {
                    testBtn.textContent = '\u2717 ' + t('Failed');
                    testBtn.style.color = 'var(--trust-low)';
                    testBtn.style.borderColor = 'var(--trust-low)';
                    testBtn.title = res.data.error || t('Unknown error');
                  }
                } else {
                  testBtn.textContent = '\u2717 ' + t('Error');
                  testBtn.style.color = 'var(--trust-low)';
                  testBtn.style.borderColor = 'var(--trust-low)';
                }
              } catch (err) {
                testBtn.textContent = '\u2717 ' + t('Error');
                testBtn.style.color = 'var(--trust-low)';
                testBtn.style.borderColor = 'var(--trust-low)';
              }
              setTimeout(function() {
                testBtn.textContent = t('Test');
                testBtn.style.color = '';
                testBtn.style.borderColor = '';
                testBtn.disabled = false;
                testBtn.title = '';
              }, 5000);
            });
          });

          // Edit buttons
          container.querySelectorAll('.provider-edit-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var pid = this.dataset.id;
              var existing = document.getElementById('provider-edit-' + pid);
              if (existing) { existing.remove(); return; } // toggle off

              var prov = _providers.find(function(p) { return p.id === pid; });
              if (!prov) return;

              var formHtml = '<div class="provider-edit-form" id="provider-edit-' + pid + '">' +
                '<div id="provider-edit-msg-' + pid + '"></div>' +
                '<div class="form-group"><label>' + t('Name') + '</label><input type="text" class="form-input" id="pedit-name-' + pid + '" value="' + escapeHtml(prov.name) + '"></div>' +
                '<div class="form-group"><label>' + t('Model') + '</label><input type="text" class="form-input" id="pedit-model-' + pid + '" value="' + escapeHtml(prov.model) + '"></div>' +
                '<div class="form-group"><label>' + t('LLM API key (leave blank to keep current)') + '</label><input type="password" class="form-input" id="pedit-key-' + pid + '" placeholder="' + t('Leave blank to keep') + '"></div>' +
                '<div class="form-group"><label>' + t('System prompt') + '</label><textarea class="form-input" rows="2" id="pedit-system-' + pid + '" class="s-a35b8b9c">' + escapeHtml(prov.system_prompt || '') + '</textarea></div>' +
                '<div class="s-9f58f320">' +
                  '<label class="form-radio"><input type="checkbox" id="pedit-default-' + pid + '"' + (prov.is_default ? ' checked' : '') + '> ' + t('Set as default') + '</label>' +
                '</div>' +
                '<div class="mt-md"><button class="btn btn-primary btn-sm" id="pedit-save-' + pid + '">' + t('Save') + '</button></div>' +
              '</div>';

              var provItem = container.querySelector('.provider-item[data-provider-id="' + pid + '"]');
              provItem.insertAdjacentHTML('afterend', formHtml);

              document.getElementById('pedit-save-' + pid).addEventListener('click', async function() {
                var body = {
                  name: document.getElementById('pedit-name-' + pid).value.trim(),
                  model: document.getElementById('pedit-model-' + pid).value.trim(),
                  systemPrompt: document.getElementById('pedit-system-' + pid).value.trim() || undefined,
                  isDefault: document.getElementById('pedit-default-' + pid).checked,
                };
                var newKey = document.getElementById('pedit-key-' + pid).value.trim();
                if (newKey) body.apiKey = newKey;
                try {
                  var res = await API.put('/ai/providers/' + pid, body);
                  if (res.status === 200) {
                    loadProviders();
                  } else {
                    var msg = (res.data && res.data.error) ? res.data.error.message : t('Failed');
                    showAlert(document.getElementById('provider-edit-msg-' + pid), 'warning', msg);
                  }
                } catch (err) {
                  showAlert(document.getElementById('provider-edit-msg-' + pid), 'warning', t('Network error.'));
                }
              });
            });
          });

          // Delete buttons
          container.querySelectorAll('.provider-delete-btn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
              if (!confirm(t('Remove this provider?'))) return;
              try {
                var delRes = await API.del('/ai/providers/' + this.dataset.id);
                if (delRes.status === 204) loadProviders();
              } catch (err) { alert(t('Failed to remove provider.')); }
            });
          });
        } else {
          container.innerHTML = '<p class="text-muted">' + t('No AI providers configured yet. Add one to use assisted agents.') + '</p>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-muted">' + t('Could not load providers.') + '</p>';
      }
    }

    async function loadSubscriptions() {
      var container = document.getElementById('sub-list');
      try {
        // Load subscriptions for all agents
        var res = await API.get('/subscriptions/me?limit=50');
        if (res.status === 200 && res.data && res.data.length > 0) {
          var subs = res.data;
          var total = res.pagination ? res.pagination.total : subs.length;
          document.getElementById('sub-count').textContent = t('{n} / 20 subscriptions', {n: total});

          // Build agent name lookup from cache
          var agentNames = {};
          subAgentsCache.forEach(function(a) { agentNames[a.id] = a.name; });

          container.innerHTML = subs.map(function(sub) {
            var icon = sub.type === 'topic' ? '&#128204;' : (sub.type === 'vector' ? '&#128302;' : '&#128273;');
            var title = sub.keyword || sub.embedding_text || sub.topic_id || t('Subscription');
            var agentName = agentNames[sub.account_id] || '';
            var agentBadge = agentName ? '<span class="badge s-b021f23b">' + escapeHtml(agentName) + '</span>' : '';
            var methodBadge = '<span class="badge s-cb9e2009">' + (sub.notification_method || 'polling') + '</span>';
            var meta = escapeHtml(sub.type) + (sub.lang ? ' &middot; ' + sub.lang.toUpperCase() : ' &middot; ' + t('All languages')) + ' &middot; ' + methodBadge;
            if (sub.type === 'vector' && sub.similarity_threshold) {
              meta += ' &middot; ' + t('threshold {value}', {value: sub.similarity_threshold});
            }
            return '<div class="sub-item">' +
              '<span class="sub-icon">' + icon + '</span>' +
              '<div class="sub-info">' +
                '<div class="sub-title">' + escapeHtml(title) + agentBadge + '</div>' +
                '<div class="sub-meta">' + meta + '</div>' +
              '</div>' +
              '<button class="btn btn-secondary btn-sm sub-remove-btn" data-id="' + sub.id + '">&#10005; ' + t('Remove') + '</button>' +
            '</div>';
          }).join('');

          container.querySelectorAll('.sub-remove-btn').forEach(function(btn) {
            btn.addEventListener('click', async function() {
              if (!confirm(t('Remove this subscription?'))) return;
              try {
                var delRes = await API.del('/subscriptions/' + this.dataset.id);
                if (delRes.status === 204) {
                  loadSubscriptions();
                }
              } catch (err) {
                alert(t('Failed to remove subscription.'));
              }
            });
          });
        } else {
          document.getElementById('sub-count').textContent = t('{n} / 20 subscriptions', {n: 0});
          container.innerHTML = '<p class="text-muted">' + t('No subscriptions yet. Create an agent and subscribe it to topics or keywords.') + '</p>';
        }
      } catch (err) {
        container.innerHTML = '<p class="text-muted">' + t('Could not load subscriptions.') + '</p>';
      }
    }
