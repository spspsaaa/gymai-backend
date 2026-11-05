#!/usr/bin/env node
/* Live smoke test for the GYM AI backend.
   Read-only: it never creates or mutates anything, it only checks that the
   service is up and that the protected routes refuse unauthenticated access.

   Usage:  node scripts/smoke.js [BASE_URL]
   Default BASE_URL: https://gymai-backend-ev1z.onrender.com  */
const BASE = (process.argv[2] || process.env.API_BASE || 'https://gymai-backend-ev1z.onrender.com').replace(/\/$/, '');

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'User-Agent': 'gymai-smoke/1.0' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let raw = '';
  try { raw = await res.text(); } catch (e) { raw = ''; }
  return { status: res.status, body: raw.slice(0, 200) };
}

const CASES = [
  ['health отвечает',                    '/health',                          { },                                   [200]],
  ['health сообщает Turso, а не файл',   '/health',                          { expectStorage: 'turso' },             [200]],
  ['состояние без токена отклоняется',    '/api/state',                       { },                                   [401, 403]],
  ['профиль аккаунта без токена',         '/api/account/me',                  { },                                   [401, 403]],
  ['профиль (GET) без токена',            '/api/account/profile',             { },                                   [401, 403]],
  ['список админов без токена',           '/api/admin/accounts',              { },                                   [401, 403]],
  ['AI-коуч без токена',                  '/api/coach',                       { method: 'POST', body: { message: 'hi' } }, [401, 403]],
  ['мусорный токен не проходит',          '/api/state',                       { token: 'garbage' },                  [401, 403]],
  ['битое тело не роняет сервис',         '/api/auth',                        { method: 'POST', body: { broken: true } }, [400, 401, 403]],
];

(async () => {
  let failed = 0;
  console.log('Backend:', BASE);
  for (const [name, path, opts, expect] of CASES) {
    let r;
    try { r = await call(path, opts); }
    catch (e) { console.log('❌', name, '->', e.message); failed++; continue; }
    let ok = expect.includes(r.status);
    if (ok && opts.expectStorage) {
      try {
        const parsed = JSON.parse(r.body);
        ok = parsed.storage === opts.expectStorage;
        if (!ok) {
          console.log('   ожидали storage=' + opts.expectStorage + ', получили ' + JSON.stringify(parsed.storage));
        }
      } catch (e) { ok = false; }
    }
    if (!ok) failed++;
    console.log((ok ? '✅' : '❌'), name, '->', r.status, r.body);
  }
  console.log(failed === 0 ? '\n✅ все проверки пройдены' : '\n❌ провалов: ' + failed);
  process.exit(failed === 0 ? 0 : 1);
})();
