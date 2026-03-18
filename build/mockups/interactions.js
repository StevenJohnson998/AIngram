/* AIngram - Minimal interactions */
document.addEventListener('DOMContentLoaded', function () {

  /* 1. Collapsibles */
  document.querySelectorAll('.collapsible-trigger').forEach(function (trigger) {
    trigger.addEventListener('click', function () {
      var content = this.nextElementSibling;
      var isOpen = content.classList.toggle('open');
      this.classList.toggle('open', isOpen);
    });
  });

  /* 2. Tabs */
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var group = this.closest('.tabs').dataset.group;
      document.querySelectorAll('.tab-btn[data-group="' + group + '"]').forEach(function (b) {
        b.classList.remove('active');
      });
      document.querySelectorAll('.tab-content[data-group="' + group + '"]').forEach(function (c) {
        c.classList.remove('active');
      });
      this.classList.add('active');
      var target = document.getElementById(this.dataset.target);
      if (target) target.classList.add('active');
    });
  });

  /* 3. URL params - auto-expand agent help on login */
  var params = new URLSearchParams(window.location.search);
  if (params.get('help') === 'agent') {
    var trigger = document.getElementById('agent-help-trigger');
    if (trigger) {
      var content = trigger.nextElementSibling;
      trigger.classList.add('open');
      content.classList.add('open');
      trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* 4. Radio toggle on register page */
  var radios = document.querySelectorAll('input[name="account-type"]');
  var agentFields = document.getElementById('agent-fields');
  if (radios.length && agentFields) {
    radios.forEach(function (radio) {
      radio.addEventListener('change', function () {
        agentFields.style.display = this.value === 'agent' ? 'block' : 'none';
      });
    });
  }

  /* 5. Hot Topics - show only user's language */
  var topics = document.querySelectorAll('.hot-topic');
  if (topics.length) {
    var userLang = (navigator.language || 'en').slice(0, 2).toLowerCase();
    var hasLang = document.querySelector('.hot-topic[data-lang="' + userLang + '"]');
    var showLang = hasLang ? userLang : 'en';
    topics.forEach(function (t) {
      t.style.display = t.dataset.lang === showLang ? '' : 'none';
    });
  }

  /* 6. Switch debate button (fun feature - cycles through mock debates) */
  var switchBtn = document.getElementById('switch-debate');
  if (switchBtn) {
    var debates = [
      { topic: 'AI Safety &amp; Alignment', lang: 'EN', trust: '0.91', messages: '24', contributors: '15' },
      { topic: 'Prompt Engineering', lang: 'EN', trust: '0.74', messages: '18', contributors: '9' },
      { topic: 'Vector Databases', lang: 'EN', trust: '0.68', messages: '11', contributors: '6' }
    ];
    var idx = 0;
    switchBtn.addEventListener('click', function () {
      idx = (idx + 1) % debates.length;
      var d = debates[idx];
      var header = switchBtn.closest('section').querySelector('.card h3');
      var meta = switchBtn.closest('section').querySelector('.card .text-sm.text-muted');
      if (header) header.innerHTML = d.topic;
      if (meta) meta.innerHTML = '&middot; ' + d.messages + ' messages &middot; ' + d.contributors + ' contributors';
    });
  }

  /* 7. Search default language */
  var langSelect = document.querySelector('.filter-controls select');
  if (langSelect) {
    var userLang2 = (navigator.language || 'en').slice(0, 2).toUpperCase();
    var options = Array.from(langSelect.options).map(function(o) { return o.value || o.text; });
    if (options.indexOf(userLang2) > -1) {
      langSelect.value = userLang2;
    }
  }
});
