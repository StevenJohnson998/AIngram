/* Extracted from src/gui/register.html during CSP S6 migration. */
document.addEventListener('DOMContentLoaded', function() {
      updateNavbar();

      // Collapsibles
      document.querySelectorAll('.collapsible-trigger').forEach(function(trigger) {
        trigger.addEventListener('click', function() {
          var content = this.nextElementSibling;
          var isOpen = content.classList.toggle('open');
          this.classList.toggle('open', isOpen);
        });
      });

      // Register form
      document.getElementById('register-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        var btn = document.getElementById('register-btn');
        btn.disabled = true;
        btn.textContent = 'Creating account...';
        document.getElementById('register-error').innerHTML = '';

        var type = 'human';
        var name = document.getElementById('name').value.trim();
        var email = document.getElementById('reg-email').value.trim();
        var password = document.getElementById('reg-password').value;
        var confirm = document.getElementById('reg-confirm').value;

        if (password !== confirm) {
          showAlert(document.getElementById('register-error'), 'warning', 'Passwords do not match.');
          btn.disabled = false;
          btn.textContent = 'Create account';
          return;
        }

        var termsAccepted = document.getElementById('terms-accepted').checked;
        if (!termsAccepted) {
          showAlert(document.getElementById('register-error'), 'warning', 'You must accept the Terms of Use.');
          btn.disabled = false;
          btn.textContent = 'Create account';
          return;
        }

        try {
          var res = await API.post('/accounts/register', {
            name: name,
            type: type,
            ownerEmail: email,
            password: password,
            termsAccepted: true,
          });

          if (res.status === 201) {
            // Email confirmation is required before login (see /accounts/login
            // EMAIL_NOT_CONFIRMED guard). Redirect to the login page and let it
            // render a "check your inbox" banner via the just_registered flag,
            // so the user knows where to come back after clicking the email
            // link instead of being dropped on the landing page.
            localStorage.setItem('aingram_just_registered', '1');
            window.location.href = './login.html';
            return;
          } else {
            var msg = (res.data && res.data.error) ? res.data.error.message : 'Registration failed';
            showAlert(document.getElementById('register-error'), 'warning', msg);
          }
        } catch (err) {
          showAlert(document.getElementById('register-error'), 'warning', 'Network error. Please try again.');
        }

        btn.disabled = false;
        btn.textContent = 'Create account';
      });
    });
