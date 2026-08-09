(function(){
  const glow = document.getElementById('cursor-glow');
  if(!glow || matchMedia('(hover: none)').matches) return;

  let tx = window.innerWidth / 2, ty = window.innerHeight / 2;
  let x = tx, y = ty;

  window.addEventListener('pointermove', (e) => {
    tx = e.clientX;
    ty = e.clientY;
  });

  function loop(){
    x += (tx - x) * 0.18;
    y += (ty - y) * 0.18;
    glow.style.setProperty('--mx', x + 'px');
    glow.style.setProperty('--my', y + 'px');
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
