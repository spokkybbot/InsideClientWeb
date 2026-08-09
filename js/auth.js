function icWirePasswordToggle(inputEl, btnEl){
  if(!inputEl || !btnEl) return;
  btnEl.addEventListener('click', () => {
    const showing = inputEl.type === 'text';
    inputEl.type = showing ? 'password' : 'text';
    btnEl.innerHTML = showing ? ICONS.eye : ICONS.eyeOff;
  });
}

/* ---------- Login ---------- */
(function initLogin(){
  const form = document.getElementById('login-form');
  if(!form) return;

  const idInput = document.getElementById('login-id');
  const passInput = document.getElementById('login-pass');
  const rememberInput = document.getElementById('login-remember');
  const submitBtn = document.getElementById('login-submit');
  const errorEl = document.getElementById('login-error');

  icWirePasswordToggle(passInput, document.getElementById('login-toggle-pass'));

  function refreshState(){
    const ready = idInput.value.trim().length > 0 && passInput.value.length > 0;
    submitBtn.disabled = !ready;
  }
  idInput.addEventListener('input', refreshState);
  passInput.addEventListener('input', refreshState);

  document.getElementById('forgot-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(IC_TELEGRAM_URL, '_blank', 'noopener');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if(submitBtn.disabled) return;
    errorEl.textContent = '';
    submitBtn.disabled = true;

    try {
      await icApiPost('/api/login', {
        login: idInput.value.trim(),
        password: passInput.value,
        remember: !!(rememberInput && rememberInput.checked),
      });
      window.location.href = 'dashboard.html';
    } catch (err) {
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
    }
  });
})();

/* ---------- Register ---------- */
(function initRegister(){
  const form = document.getElementById('register-form');
  if(!form) return;

  const loginInput = document.getElementById('reg-login');
  const passInput = document.getElementById('reg-pass');
  const pass2Input = document.getElementById('reg-pass2');
  const submitBtn = document.getElementById('register-submit');
  const errorEl = document.getElementById('register-error');

  icWirePasswordToggle(passInput, document.getElementById('reg-toggle-pass1'));
  icWirePasswordToggle(pass2Input, document.getElementById('reg-toggle-pass2'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const isEN = localStorage.getItem('ic_lang') === 'EN';

    if(!loginInput.value.trim() || !passInput.value || !pass2Input.value){
      errorEl.textContent = isEN ? 'Fill in every field.' : 'Заполните все поля.';
      return;
    }
    if(passInput.value !== pass2Input.value){
      errorEl.textContent = isEN ? 'Passwords do not match.' : 'Пароли не совпадают.';
      return;
    }

    submitBtn.disabled = true;
    try {
      await icApiPost('/api/register', {
        login: loginInput.value.trim(),
        password: passInput.value,
      });
      icToast(icT('toast.registerOk'));
      setTimeout(() => { window.location.href = 'dashboard.html'; }, 900);
    } catch (err) {
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
    }
  });
})();
