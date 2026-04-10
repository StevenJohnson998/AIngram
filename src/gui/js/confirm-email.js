/* Extracted from src/gui/confirm-email.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', async function() {
      var container = document.getElementById('confirm-result');
      var params = new URLSearchParams(window.location.search);
      var token = params.get('token');

      if (!token) {
        container.innerHTML = '<div class="alert alert-warning">Missing confirmation token.</div>';
        return;
      }

      try {
        var res = await API.get('/accounts/confirm-email?token=' + encodeURIComponent(token));
        if (res.status === 200) {
          container.innerHTML =
            '<div class="alert alert-success">Email confirmed! You can now <a href="./login.html">log in</a>.</div>';
        } else {
          var msg = (res.data && res.data.error) ? res.data.error.message : 'Confirmation failed';
          container.innerHTML =
            '<div class="alert alert-warning">' + escapeHtml(msg) + '</div>' +
            '<p class="mt-md text-sm text-muted">The link may have expired. <a href="./login.html">Log in</a> to request a new one.</p>';
        }
      } catch (err) {
        container.innerHTML = '<div class="alert alert-warning">Network error. Please try again.</div>';
      }
    });
