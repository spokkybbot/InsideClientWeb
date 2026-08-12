/* Фоновый эмбиент + звуки интерфейса (hover/click), без mp3-файлов —
   всё генерируется на лету через Web Audio API, поэтому не нужно
   тащить лицензированную музыку и грузить лишние ассеты.

   Правила громкости продуманы так, чтобы звук был реально фоновый и
   не раздражал: тихий дрон + мягкие фильтрованные тоны на кнопках.
   Автоплей со звуком браузеры блокируют до первого жеста пользователя —
   поэтому и эмбиент, и звуки кнопок стартуют по первому клику/тапу/
   нажатию клавиши, это нормальное поведение, не баг.

   Состояние (звук вкл/выкл) сохраняется в localStorage и уважается
   на всех страницах сайта. */

const IC_AUDIO_MUTE_KEY = 'ic_audio_muted';

function icAudioIsMuted(){
  return localStorage.getItem(IC_AUDIO_MUTE_KEY) === '1';
}

(function(){
  let ctx = null;
  let masterGain = null;      // общая громкость всего звука сайта
  let ambientGain = null;     // громкость именно фоновой музыки
  let ambientNodes = [];
  let started = false;
  let muted = icAudioIsMuted();

  const AMBIENT_TARGET = 0.05;   // тихо — реально фон, не мешает
  const HOVER_GAIN = 0.035;
  const CLICK_GAIN = 0.06;

  function ensureContext(){
    if(ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
    masterGain.connect(ctx.destination);
    return ctx;
  }

  /* ---------------------------------------------------------------
     Генеративный эмбиент: несколько мягких детюнированных тонов через
     lowpass-фильтр с медленной LFO-модуляцией — спокойный «плывущий»
     пад без резких атак, без слов, ничего кислотного.
     --------------------------------------------------------------- */
  function startAmbient(){
    if(started || !ctx) return;
    started = true;

    ambientGain = ctx.createGain();
    ambientGain.gain.value = 0;
    ambientGain.connect(masterGain);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.3;
    filter.connect(ambientGain);

    // Тихий мягкий пад из нескольких тонов (пентатоника, без диссонанса)
    const baseFreqs = [110, 130.81, 164.81, 196];
    ambientNodes = baseFreqs.map((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.value = freq;
      osc.detune.value = (i - baseFreqs.length / 2) * 4;

      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 1 / baseFreqs.length;

      // Медленная LFO на громкость каждого голоса — лёгкое «дыхание»
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.05 + i * 0.02;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.4 / baseFreqs.length;
      lfo.connect(lfoGain);
      lfoGain.connect(voiceGain.gain);

      osc.connect(voiceGain);
      voiceGain.connect(filter);
      osc.start();
      lfo.start();
      return { osc, lfo, voiceGain };
    });

    // Очень медленная LFO на частоту среза фильтра — эффект "плывущего" тембра
    const filterLfo = ctx.createOscillator();
    filterLfo.type = 'sine';
    filterLfo.frequency.value = 0.025;
    const filterLfoGain = ctx.createGain();
    filterLfoGain.gain.value = 350;
    filterLfo.connect(filterLfoGain);
    filterLfoGain.connect(filter.frequency);
    filterLfo.start();
    ambientNodes.push({ osc: filterLfo });

    // Плавный fade-in, чтобы не было щелчка/резкого появления звука
    const now = ctx.currentTime;
    ambientGain.gain.setValueAtTime(0, now);
    ambientGain.gain.linearRampToValueAtTime(AMBIENT_TARGET, now + 4);
  }

  /* ---------------------------------------------------------------
     Короткие UI-звуки: мягкий отфильтрованный синус с быстрым затуханием.
     --------------------------------------------------------------- */
  function playTone(freq, duration, gainValue){
    if(!ctx || muted) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2200;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(gainValue, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);

    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  function playHover(){ playTone(720, 0.09, HOVER_GAIN); }
  function playClick(){
    playTone(560, 0.11, CLICK_GAIN);
    setTimeout(() => playTone(840, 0.09, CLICK_GAIN * 0.7), 35);
  }

  /* ---------------------------------------------------------------
     Делегирование событий — работает и на кнопках, добавленных позже
     динамически (тема, модалки, тосты и т.д.), без индивидуальных
     обработчиков на каждый элемент.
     --------------------------------------------------------------- */
  const INTERACTIVE_SELECTOR = 'button, a.btn, .btn, .theme-switch-btn, .theme-swatch, .social-btn, a[href]';

  function onPointerOver(e){
    const target = e.target.closest(INTERACTIVE_SELECTOR);
    if(!target || target.dataset.icAudioHovered === '1') return;
    target.dataset.icAudioHovered = '1';
    playHover();
  }
  function onPointerOut(e){
    const target = e.target.closest(INTERACTIVE_SELECTOR);
    if(target) delete target.dataset.icAudioHovered;
  }
  function onClick(e){
    if(e.target.closest(INTERACTIVE_SELECTOR)) playClick();
  }

  function updateToggleBtn(){
    const btn = document.getElementById('audio-toggle-btn');
    if(!btn) return;
    btn.innerHTML = muted ? ICONS.volumeOff : ICONS.volume;
    btn.classList.toggle('is-muted', muted);
    btn.setAttribute('aria-pressed', String(muted));
  }

  function setMuted(next){
    muted = next;
    localStorage.setItem(IC_AUDIO_MUTE_KEY, muted ? '1' : '0');
    if(masterGain && ctx){
      const now = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.linearRampToValueAtTime(muted ? 0 : 1, now + 0.25);
    }
    updateToggleBtn();
  }

  function firstGesture(){
    const c = ensureContext();
    if(c && c.state === 'suspended') c.resume();
    startAmbient();
    window.removeEventListener('pointerdown', firstGesture);
    window.removeEventListener('keydown', firstGesture);
    window.removeEventListener('touchstart', firstGesture);
  }

  function init(){
    updateToggleBtn();
    document.getElementById('audio-toggle-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      setMuted(!muted);
    });

    window.addEventListener('pointerdown', firstGesture, { passive: true });
    window.addEventListener('keydown', firstGesture);
    window.addEventListener('touchstart', firstGesture, { passive: true });

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('click', onClick);
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
