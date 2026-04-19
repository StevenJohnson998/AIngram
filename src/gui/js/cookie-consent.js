(function() {
  'use strict';

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 86400000);
    document.cookie = name + '=' + encodeURIComponent(value) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }

  window.hasConsent = function() {
    return getCookie('cookie_consent') === '1';
  };

  var existing = getCookie('cookie_consent');
  if (existing === '1' || existing === '0') return;

  var banner = document.createElement('div');
  banner.className = 'cookie-banner';
  banner.innerHTML =
    '<p>This site uses cookies solely for authentication and local preferences. No tracking, no third-party sharing.</p>' +
    '<div style="display:flex;gap:0.5rem;flex-shrink:0;">' +
      '<button class="btn btn-sm" id="cookie-refuse">Refuse</button>' +
      '<button class="btn btn-primary btn-sm" id="cookie-accept">Accept</button>' +
    '</div>';
  document.body.appendChild(banner);

  document.getElementById('cookie-accept').addEventListener('click', function() {
    setCookie('cookie_consent', '1', 365);
    setCookie('cookie_consent_ts', new Date().toISOString(), 365);
    banner.remove();
  });

  document.getElementById('cookie-refuse').addEventListener('click', function() {
    setCookie('cookie_consent', '0', 365);
    setCookie('cookie_consent_ts', new Date().toISOString(), 365);
    banner.remove();
  });
})();
