const PLANS = [
  {
    id: 'month1',
    icon: 'bolt',
    price: 50,
    name: { RU: '1 месяц', EN: '1 month' },
    desc: { RU: 'Попробовать без обязательств', EN: 'Try it, no strings attached' },
  },
  {
    id: 'month3',
    icon: 'gem',
    price: 120,
    name: { RU: '3 месяца', EN: '3 months' },
    desc: { RU: 'Оптимальный вариант для сезона', EN: 'Best value for a season' },
    featured: true,
  },
  {
    id: 'year',
    icon: 'shield',
    price: 190,
    name: { RU: 'Год', EN: 'Year' },
    desc: { RU: 'Полный сезон без переплат', EN: 'A full year, at a fraction of the cost' },
  },
  {
    id: 'forever',
    icon: 'infinity',
    price: 250,
    name: { RU: 'Навсегда', EN: 'Lifetime' },
    desc: { RU: 'Один платёж — доступ навсегда', EN: 'Pay once, keep it forever' },
  },
  {
    id: 'hwid',
    icon: 'refresh',
    price: 50,
    name: { RU: 'Сброс HWID', EN: 'HWID reset' },
    desc: { RU: 'Перепривязка к новому железу', EN: 'Re-link your license to new hardware' },
  },
];

function icRenderPlans(){
  const grid = document.getElementById('plans-grid');
  if(!grid) return;
  const lang = (localStorage.getItem('ic_lang') === 'EN') ? 'EN' : 'RU';

  grid.innerHTML = PLANS.map((plan, i) => `
    <div class="plan-card reveal ${plan.featured ? 'featured' : ''}" style="transition-delay:${i * 0.06}s">
      <div class="plan-art">${ICONS[plan.icon]}</div>
      <div class="plan-name">${plan.name[lang]}</div>
      <div class="plan-desc">${plan.desc[lang]}</div>
      <div class="plan-price"><span class="amount">${plan.price}</span><span class="cur">₽</span></div>
      <button type="button" class="btn btn-primary btn-block" data-plan="${plan.id}">
        ${ICONS.cart}<span>${icT('buy.action')}</span>
      </button>
    </div>
  `).join('');

  grid.querySelectorAll('[data-plan]').forEach(btn => {
    btn.addEventListener('click', () => {
      if(!window.icCurrentUser){
        icToast(icT('login.title'));
        setTimeout(() => { window.location.href = 'login.html'; }, 700);
        return;
      }
      if(!window.icCurrentUser.telegram){
        icToast(icT('toast.telegramRequired'));
        setTimeout(() => { window.location.href = 'dashboard.html'; }, 900);
        return;
      }
      // Purchase flow is a placeholder for now — a dedicated checkout page
      // will replace this direct-buy call.
      icToast(icT('toast.buyStub'));
    });
  });

  icInitReveal();
}

document.addEventListener('DOMContentLoaded', icRenderPlans);
document.addEventListener('ic:langchange', icRenderPlans);
