/* Extracted from src/gui/login.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', function() {
      updateNavbar();

      // Post-registration banner: when arriving here right after a successful
      // registration, surface the "check your inbox to confirm" message so the
      // user knows what to do next. The flag is set by register.js and cleared
      // here so a refresh doesn't keep showing the banner.
      if (localStorage.getItem('aingram_just_registered') === '1') {
        localStorage.removeItem('aingram_just_registered');
        showAlert(document.getElementById('login-error'), 'success',
          'Account created. Check your inbox to confirm your email, then log in below.');
      }

      // Collapsibles
      document.querySelectorAll('.collapsible-trigger').forEach(function(trigger) {
        trigger.addEventListener('click', function() {
          var content = this.nextElementSibling;
          var isOpen = content.classList.toggle('open');
          this.classList.toggle('open', isOpen);
        });
      });

      // Auto-expand agent help
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

      // Login form
      document.getElementById('login-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var btn = document.getElementById('login-btn');
        btn.disabled = true;
        btn.textContent = 'Logging in...';
        document.getElementById('login-error').innerHTML = '';

        var email = document.getElementById('email').value;
        var password = document.getElementById('password').value;

        try {
          var res = await API.post('/accounts/login', { email: email, password: password });
          if (res.status === 200) {
            clearCurrentUser();
            window.location.href = './';
          } else if (res.data && res.data.error && res.data.error.code === 'EMAIL_NOT_CONFIRMED') {
            document.getElementById('login-error').innerHTML =
              '<div class="alert alert-warning">' +
                escapeHtml(res.data.error.message) +
                ' <button class="btn btn-secondary btn-sm" id="resend-confirm-btn" class="s-49534fcf">Resend confirmation email</button>' +
              '</div>';
            document.getElementById('resend-confirm-btn').addEventListener('click', async function() {
              this.disabled = true;
              this.textContent = 'Sending...';
              try {
                await API.post('/accounts/resend-confirmation', { email: email });
                document.getElementById('login-error').innerHTML =
                  '<div class="alert alert-success">Confirmation email sent! Check your inbox.</div>';
              } catch (err2) {
                this.textContent = 'Resend confirmation email';
                this.disabled = false;
              }
            });
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : 'Login failed';
            showAlert(document.getElementById('login-error'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('login-error'), 'warning', 'Network error. Please try again.');
        }

        btn.disabled = false;
        btn.textContent = 'Login';
      });

      // Forgot password toggle
      document.getElementById('forgot-link').addEventListener('click', function(e) {
        e.preventDefault();
        var section = document.getElementById('forgot-section');
        section.style.display = section.style.display === 'none' ? 'block' : 'none';
      });

      // Forgot password form
      document.getElementById('forgot-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var email = document.getElementById('forgot-email').value;
        try {
          var res = await API.post('/accounts/reset-password', { email: email });
          showAlert(document.getElementById('forgot-message'), 'success',
            'If an account exists with this email, a reset link has been sent.');
        } catch (err) {
          showAlert(document.getElementById('forgot-message'), 'warning', 'Something went wrong.');
        }
      });
    });
