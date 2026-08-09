function icWirePasswordVisibility(inputEl, btnEl){
  if(!inputEl || !btnEl) return;
  btnEl.addEventListener('click', () => {
    const showing = inputEl.type === 'text';
    inputEl.type = showing ? 'password' : 'text';
    btnEl.innerHTML = showing ? ICONS.eye : ICONS.eyeOff;
  });
}

(function initPasswordPage(){
  const form = document.getElementById('password-form');
  if(!form) return;

  const oldInput = document.getElementById('password-old');
  const newInput = document.getElementById('password-new');
  const new2Input = document.getElementById('password-new2');
  const submitBtn = document.getElementById('password-submit');
  const errorEl = document.getElementById('password-error');

  icWirePasswordVisibility(oldInput, document.getElementById('password-toggle-old'));
  icWirePasswordVisibility(newInput, document.getElementById('password-toggle-new'));
  icWirePasswordVisibility(new2Input, document.getElementById('password-toggle-new2'));

  document.getElementById('password-forgot-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.open(IC_TELEGRAM_URL, '_blank', 'noopener');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const oldPassword = oldInput.value;
    const newPassword = newInput.value;
    const newPassword2 = new2Input.value;

    if(!oldPassword || !newPassword || !newPassword2){
      errorEl.textContent = icT('login.title') === 'Sign in' ? 'Fill in every field.' : 'Заполните все поля.';
      return;
    }
    if(newPassword !== newPassword2){
      errorEl.textContent = icT('password.mismatch');
      return;
    }

    submitBtn.disabled = true;
    try {
      await icApiPost('/api/password/change', { oldPassword, newPassword });
      icToast(icT('toast.passwordChanged'));
      setTimeout(() => { window.location.href = 'dashboard.html'; }, 700);
    } catch (err) {
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
    }
  });
})();
