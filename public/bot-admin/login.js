const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');
const submitBtn = document.getElementById('login-submit');
const togglePassword = document.getElementById('toggle-password');
const passwordInput = form.querySelector('input[name="password"]');

togglePassword.addEventListener('click', () => {
  const isPassword = passwordInput.type === 'password';
  passwordInput.type = isPassword ? 'text' : 'password';
});

async function checkSession() {
  const response = await fetch('/bot-admin/api/session', { credentials: 'same-origin' });
  if (response.ok) {
    window.location.href = '/bot-admin/';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  submitBtn.disabled = true;

  const formData = new FormData(form);
  try {
    const response = await fetch('/bot-admin/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: formData.get('login'),
        password: formData.get('password'),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || 'Не удалось войти');
    }
    window.location.href = '/bot-admin/';
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

checkSession();
