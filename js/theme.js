/* Theme switcher — accent-color themes, persisted in localStorage.
   The actual attribute is set as early as possible by a tiny inline script
   in each page's <head> (see icApplyStoredThemeEarly below, called inline)
   to avoid a flash of the wrong theme; this file just wires up the picker UI. */

const IC_THEMES = [
  { id: 'mono',    label: 'Чёрно-белая' },
  { id: 'purple',  label: 'Фиолетовая' },
  { id: 'emerald', label: 'Изумрудная' },
  { id: 'crimson', label: 'Красная' },
  { id: 'ocean',   label: 'Океан' },
  { id: 'sunset',  label: 'Закат' },
  { id: 'cyber',   label: 'Кибер' },
  { id: 'gold',    label: 'Золото' },
  { id: 'matrix',  label: 'Матрица' },
  { id: 'rose',    label: 'Розовая' },
];
const IC_DEFAULT_THEME = 'mono';

function icGetTheme(){
  const saved = localStorage.getItem('ic_theme');
  return IC_THEMES.some(t => t.id === saved) ? saved : IC_DEFAULT_THEME;
}

function icApplyTheme(theme){
  const id = IC_THEMES.some(t => t.id === theme) ? theme : IC_DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('ic_theme', id);
  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === id);
  });
}

function icInitThemeSwitch(){
  const btn = document.getElementById('theme-switch-btn');
  const menu = document.getElementById('theme-switch-menu');
  if(!btn || !menu) return;

  document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.classList.toggle('active', swatch.dataset.theme === icGetTheme());
    swatch.addEventListener('click', () => {
      icApplyTheme(swatch.dataset.theme);
      menu.classList.add('hidden');
    });
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if(!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn){
      menu.classList.add('hidden');
    }
  });
}
