// Cloudflare Worker — прозрачный reverse-proxy для основного сайта Inside Client.
// Нужен, потому что railway-деплой недоступен без VPN.
//
// Установка:
//   1. Workers & Pages -> Create Worker -> Paste всё сюда -> Deploy.
//   2. В Settings -> Variables -> ключ UPSTREAM = https://<твой-railway-url>
//      (без слэша в конце, например https://inside-client-production.up.railway.app)
//   3. Виджет в клиенте и личный кабинет обращаются к <worker>.<sub>.workers.dev
//
// Проксирует ЛЮБОЙ метод/путь/тело и форвардит cookie/заголовки, чтобы
// работали и cookie-сессии (личный кабинет), и HWID-запросы клиента.

export default {
  async fetch(request, env) {
    const upstream = (env.UPSTREAM || '').replace(/\/+$/, '');
    if (!upstream) {
      return new Response('UPSTREAM not configured', { status: 500 });
    }

    const url = new URL(request.url);
    const target = upstream + url.pathname + url.search;

    const headers = new Headers(request.headers);
    // Убираем hop-by-hop / cloudflare-специфичные заголовки — их расставит
    // текущий запрос к upstream заново.
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');
    headers.delete('x-forwarded-for'); // пусть upstream поставит свой

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    try {
      const resp = await fetch(target, init);
      const outHeaders = new Headers(resp.headers);
      outHeaders.set('Access-Control-Allow-Origin', '*');
      outHeaders.set('Access-Control-Allow-Credentials', 'true');
      outHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE, PUT');
      outHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: outHeaders });
      }
      return new Response(resp.body, { status: resp.status, headers: outHeaders });
    } catch (e) {
      return new Response('Proxy error: ' + e.message, { status: 502 });
    }
  },
};
