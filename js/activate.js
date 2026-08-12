(function initActivatePage(){
  const form = document.getElementById('activate-form');
  if(!form) return;

  const keyInput = document.getElementById('activate-key');
  const submitBtn = document.getElementById('activate-submit');
  const errorEl = document.getElementById('activate-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const key = keyInput.value.trim();
    if(!key){
      errorEl.textContent = icT('toast.keyEmpty');
      return;
    }

    submitBtn.disabled = true;
    try {
      await icApiPost('/api/key/activate', { key });
      icToast(icT('toast.keyActivated'));
      setTimeout(() => { window.location.href = 'dashboard.html'; }, 700);
    } catch (err) {
      errorEl.textContent = err.message;
      submitBtn.disabled = false;
    }
  });
})();
