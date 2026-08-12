let icToastTimer = null;
function icToast(message){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(icToastTimer);
  icToastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function icInitReveal(){
  const items = document.querySelectorAll('.reveal');
  if(!items.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting){
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
  items.forEach(el => io.observe(el));

  // Safety net: guarantee content never stays invisible if a fast or
  // programmatic scroll happens to skip an intersection callback.
  setTimeout(() => {
    document.querySelectorAll('.reveal:not(.in)').forEach(el => el.classList.add('in'));
  }, 2500);
}

document.addEventListener('DOMContentLoaded', () => {
  icMountShell(document.body.dataset.page);
  icInitReveal();
});
