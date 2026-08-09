/* Thin wrapper around fetch() for talking to the Inside Client backend.
   Every call sends/receives the httpOnly session cookie automatically. */

async function icApi(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }

  if (!res.ok) {
    const message = (data && data.error) ? data.error : `Ошибка (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

const icApiGet = (url) => icApi('GET', url);
const icApiPost = (url, body) => icApi('POST', url, body);
const icApiDelete = (url, body) => icApi('DELETE', url, body);
