const PLANS = [
  {
    id: 'month1',
    icon: 'bolt',
    price: 50,
    category: 'client',
    name: { RU: '1 месяц', EN: '1 month' },
    desc: { RU: 'Попробовать без обязательств', EN: 'Try it, no strings attached' },
  },
  {
    id: 'month3',
    icon: 'gem',
    price: 120,
    category: 'client',
    name: { RU: '3 месяца', EN: '3 months' },
    desc: { RU: 'Оптимальный вариант для сезона', EN: 'Best value for a season' },
    featured: true,
  },
  {
    id: 'month6',
    icon: 'shield',
    price: 150,
    category: 'client',
    name: { RU: '6 месяцев', EN: '6 months' },
    desc: { RU: 'Полгода без переплат', EN: 'Half a year, at a fraction of the cost' },
  },
  {
    id: 'forever',
    icon: 'infinity',
    price: 250,
    category: 'client',
    name: { RU: 'Навсегда', EN: 'Lifetime' },
    desc: { RU: 'Один платёж — доступ навсегда', EN: 'Pay once, keep it forever' },
  },
  {
    id: 'hwid',
    icon: 'refresh',
    price: 50,
    category: 'other',
    name: { RU: 'Сброс HWID', EN: 'HWID reset' },
    desc: { RU: 'Перепривязка к новому железу', EN: 'Re-link your license to new hardware' },
  },
  {
    id: 'bot',
    icon: 'chat',
    price: 50,
    category: 'other',
    name: { RU: 'Доступ к Spooky Events', EN: 'Spooky Events access' },
    desc: { RU: 'Открывает @Sp00kyEventsBot — требуется привязанный Telegram', EN: 'Unlocks @Sp00kyEventsBot — requires a linked Telegram account' },
  },
];

function icRenderPlanCard(plan, i){
  return `
    <div class="plan-card reveal ${plan.featured ? 'featured' : ''}" style="transition-delay:${i * 0.06}s">
      <div class="plan-art">${ICONS[plan.icon]}</div>
      <div class="plan-body">
        <div class="plan-name">${plan.name[icBuyLang()]}</div>
        <div class="plan-desc">${plan.desc[icBuyLang()]}</div>
        <div class="plan-bottom">
          <div class="plan-price"><span class="amount">${plan.price}</span><span class="cur">₽</span></div>
          <button type="button" class="btn btn-primary" data-plan="${plan.id}">
            ${ICONS.cart}<span>${icT('buy.action')}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function icBuyLang(){
  return (localStorage.getItem('ic_lang') === 'EN') ? 'EN' : 'RU';
}

function icRenderPlans(){
  const gridClient = document.getElementById('plans-grid-client');
  const gridOther = document.getElementById('plans-grid-other');
  if(!gridClient || !gridOther) return;

  const clientPlans = PLANS.filter(p => p.category !== 'other');
  const otherPlans = PLANS.filter(p => p.category === 'other');

  gridClient.innerHTML = clientPlans.map(icRenderPlanCard).join('');
  gridOther.innerHTML = otherPlans.map(icRenderPlanCard).join('');

  const allButtons = [...gridClient.querySelectorAll('[data-plan]'), ...gridOther.querySelectorAll('[data-plan]')];
  allButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      if(!window.icCurrentUser){
        icToast(icT('login.title'));
        setTimeout(() => { window.location.href = 'login.html'; }, 700);
        return;
      }
      const planId = btn.dataset.plan;
      btn.disabled = true;
      try {
        const data = await icApiPost('/api/purchases/buy', { plan: planId });
        if(data.redirect){
          icToast(icT('toast.redirectFunpay'));
          setTimeout(() => { window.location.href = data.redirect; }, 600);
          return;
        }
        // HWID reset (or any other plan that resolves immediately) lands here.
        icToast(icT('toast.hwidResetOk'));
      } catch (err) {
        icToast(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  icInitReveal();
}

document.addEventListener('DOMContentLoaded', icRenderPlans);
document.addEventListener('ic:langchange', icRenderPlans);
