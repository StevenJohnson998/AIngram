/* Extracted from src/gui/confirm-email.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', async function() {
      var container = document.getElementById('confirm-result');
      var params = new URLSearchParams(window.location.search);
      var token = params.get('token');

      if (!token) {
        container.innerHTML = '<div class="alert alert-warning">' + escapeHtml(t('Missing confirmation token.')) + '</div>';
        return;
      }

      try {
        var res = await API.get('/accounts/confirm-email?token=' + encodeURIComponent(token));
        if (res.status === 200) {
          container.innerHTML =
            '<div class="alert alert-success">' + t('Email confirmed! You can now {linkStart}log in{linkEnd}.', { linkStart: '<a href="./login.html">', linkEnd: '</a>' }) + '</div>';
        } else {
          var msg = (res.data && res.data.error) ? res.data.error.message : t('Confirmation failed');
          container.innerHTML =
            '<div class="alert alert-warning">' + escapeHtml(msg) + '</div>' +
            '<p class="mt-md text-sm text-muted">' + t('The link may have expired. {linkStart}Log in{linkEnd} to request a new one.', { linkStart: '<a href="./login.html">', linkEnd: '</a>' }) + '</p>';
        }
      } catch (err) {
        container.innerHTML = '<div class="alert alert-warning">' + escapeHtml(t('Network error. Please try again.')) + '</div>';
      }
    });
