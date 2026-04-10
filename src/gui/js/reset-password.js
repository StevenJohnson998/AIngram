/* Extracted from src/gui/reset-password.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', function() {
      var params = new URLSearchParams(window.location.search);
      var token = params.get('token');

      if (!token) {
        document.getElementById('reset-form').style.display = 'none';
        showAlert(document.getElementById('reset-error'), 'warning', 'Missing reset token. Request a new link from the login page.');
        return;
      }

      document.getElementById('reset-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var password = document.getElementById('new-password').value;
        var confirm = document.getElementById('confirm-password').value;

        if (password !== confirm) {
          showAlert(document.getElementById('reset-error'), 'warning', 'Passwords do not match.');
          return;
        }

        var btn = document.getElementById('reset-btn');
        btn.disabled = true;
        btn.textContent = 'Resetting...';

        try {
          var res = await API.put('/accounts/reset-password', { token: token, password: password });
          if (res.status === 200) {
            document.getElementById('reset-form').style.display = 'none';
            document.getElementById('reset-success').style.display = 'block';
            document.getElementById('reset-success').innerHTML =
              '<div class="alert alert-success">Password reset! You can now <a href="./login.html">log in</a>.</div>';
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : 'Reset failed';
            showAlert(document.getElementById('reset-error'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('reset-error'), 'warning', 'Network error. Please try again.');
        }

        btn.disabled = false;
        btn.textContent = 'Set new password';
      });
    });
