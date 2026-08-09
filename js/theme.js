/* Theme switcher — accent-color themes, persisted in localStorage.
   The actual attribute is set as early as possible by a tiny inline script
   in each page's <head> (see the inline script duplicated there) to avoid
   a flash of the wrong theme; this file just wires up the picker UI.

   On top of the fixed presets below, there's also a "custom" theme: the
   user picks one accent color, and a full palette (background, surface,
   text tones, etc.) is derived from it and stored in localStorage so it
   can be re-applied instantly on the next page load. */

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
const IC_CUSTOM_DEFAULT_HEX = '#9b6bff';
const IC_CUSTOM_VARS = [
  '--bg', '--bg-soft', '--surface', '--surface-2',
  '--border', '--border-strong',
  '--text', '--text-dim', '--text-faint', '--white',
  '--accent', '--accent-2', '--accent-rgb',
];

function icGetCustomAccentHex(){
  const saved = localStorage.getItem('ic_custom_accent');
  return /^#[0-9a-fA-F]{6}$/.test(saved) ? saved : IC_CUSTOM_DEFAULT_HEX;
}

function icHexToRgbArr(hex){
  let h = (hex || '').replace('#', '');
  if(h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  if(Number.isNaN(num)) return icHexToRgbArr(IC_CUSTOM_DEFAULT_HEX);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function icMixRgb(a, b, t){
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function icRgbToHex(rgb){
  return '#' + rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

function icRgbCss(rgb){ return `${rgb[0]},${rgb[1]},${rgb[2]}`; }

// Derives a full dark palette from a single accent color, in the same
// spirit as the hand-picked preset themes above (dark, faintly tinted
// backgrounds; a light, saturated accent; readable dimmed text tones).
function icBuildCustomPalette(hex){
  const accentRgb = icHexToRgbArr(hex);
  const black = [5, 5, 8];
  const white = [255, 255, 255];
  const greyDim = [150, 150, 160];
  const greyFaint = [90, 90, 98];

  const bg       = icMixRgb(black, accentRgb, 0.05);
  const bgSoft   = icMixRgb(black, accentRgb, 0.09);
  const surface  = icMixRgb(black, accentRgb, 0.16);
  const surface2 = icMixRgb(black, accentRgb, 0.22);
  const accent2  = icMixRgb(accentRgb, white, 0.38);
  const text     = icMixRgb(white, accentRgb, 0.05);
  const textDim  = icMixRgb(greyDim, accentRgb, 0.32);
  const textFaint= icMixRgb(greyFaint, accentRgb, 0.32);

  return {
    '--bg': icRgbToHex(bg),
    '--bg-soft': icRgbToHex(bgSoft),
    '--surface': icRgbToHex(surface),
    '--surface-2': icRgbToHex(surface2),
    '--border': `rgba(${icRgbCss(accentRgb)},.13)`,
    '--border-strong': `rgba(${icRgbCss(accentRgb)},.26)`,
    '--text': icRgbToHex(text),
    '--text-dim': icRgbToHex(textDim),
    '--text-faint': icRgbToHex(textFaint),
    '--white': '#ffffff',
    '--accent': icRgbToHex(accentRgb),
    '--accent-2': icRgbToHex(accent2),
    '--accent-rgb': icRgbCss(accentRgb),
  };
}

function icApplyPaletteVars(vars){
  const style = document.documentElement.style;
  Object.keys(vars).forEach(k => style.setProperty(k, vars[k]));
}

function icClearCustomPaletteVars(){
  const style = document.documentElement.style;
  IC_CUSTOM_VARS.forEach(k => style.removeProperty(k));
}

function icGetTheme(){
  const saved = localStorage.getItem('ic_theme');
  if(saved === 'custom') return 'custom';
  return IC_THEMES.some(t => t.id === saved) ? saved : IC_DEFAULT_THEME;
}

function icSetActiveSwatch(id){
  document.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === id);
  });
  document.getElementById('theme-swatch-custom')?.classList.toggle('active', id === 'custom');
}

function icApplyTheme(theme){
  const id = IC_THEMES.some(t => t.id === theme) ? theme : IC_DEFAULT_THEME;
  icClearCustomPaletteVars();
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem('ic_theme', id);
  icSetActiveSwatch(id);
}

// Picks (or re-applies) a custom accent color: derives the full palette,
// persists both the raw color and the derived palette, and switches to it.
function icApplyCustomAccent(hex){
  if(!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const palette = icBuildCustomPalette(hex);
  localStorage.setItem('ic_custom_accent', hex);
  localStorage.setItem('ic_custom_palette', JSON.stringify(palette));
  localStorage.setItem('ic_theme', 'custom');
  document.documentElement.setAttribute('data-theme', 'custom');
  icApplyPaletteVars(palette);
  icSetActiveSwatch('custom');
}

function icInitThemeSwitch(){
  const btn = document.getElementById('theme-switch-btn');
  const menu = document.getElementById('theme-switch-menu');
  if(!btn || !menu) return;

  document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      icApplyTheme(swatch.dataset.theme);
      menu.classList.add('hidden');
    });
  });

  const customInput = document.getElementById('theme-custom-color');
  if(customInput){
    customInput.addEventListener('input', () => icApplyCustomAccent(customInput.value));
    customInput.addEventListener('change', () => {
      icApplyCustomAccent(customInput.value);
      icToast(icT('theme.custom.saved'));
      menu.classList.add('hidden');
    });
    customInput.addEventListener('click', (e) => e.stopPropagation());
  }

  icSetActiveSwatch(icGetTheme());

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
