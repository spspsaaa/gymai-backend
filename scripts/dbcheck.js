#!/usr/bin/env node
/* Проверка того, где бэкенд реально хранит данные.

   Два режима:

   1) Через живой сервис (без секретов) — берём /health и смотрим поле
      `storage`. 'turso' значит, что данные в базе и переживают рестарт,
      'file' — что сервер откатился на локальный файл.

        node scripts/dbcheck.js --url https://gymai-backend-ev1z.onrender.com

   2) Прямо в Turso (нужны креды) — проверяем наличие служебных таблиц и
      печатаем количество строк в каждой.

        TURSO_URL=libsql://... TURSO_TOKEN=... node scripts/dbcheck.js
*/

const TABLES = ['users', 'accounts', 'states', 'sessions', 'account_sessions', 'admin_sessions', 'state_migrations'];
const DEFAULT_SERVICE = 'https://gymai-backend-ev1z.onrender.com';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function viaService(base) {
  console.log('Сервис:', base);
  const res = await fetch(base.replace(/\/$/, '') + '/health');
  if (!res.ok) { console.log('❌ /health вернул', res.status); return false; }
  const h = await res.json();
  console.log('   /health:', JSON.stringify(h));
  if (h.storage === 'turso') {
    console.log('✅ сервер на Turso: данные в базе, рестарт их не потеряет');
    return true;
  }
  if (h.storage === 'file') {
    console.log('❌ сервер на локальном файле: данные пропадут при рестарте');
    return false;
  }
  console.log('⚠️  сервер не сообщает режим хранения — версия старее, обновите бэкенд');
  return false;
}

async function viaTurso(url, token) {
  const host = url.replace(/^libsql:\/\//, '').replace(/^https?:\/\//, '');
  const query = async (sql) => {
    const res = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }] }),
    });
    const d = await res.json();
    const r = d.results?.[0];
    if (!r || r.type === 'error') throw new Error(r?.error?.message || 'unknown error');
    return r.response?.result?.rows || [];
  };
  console.log('Turso:', host);
  const got = (await query("select name from sqlite_master where type='table'")).map((r) => r[0].value);
  const missing = TABLES.filter((t) => !got.includes(t));
  console.log('   таблиц в базе:', got.length);
  if (missing.length) { console.log('❌ нет таблиц:', missing.join(', ')); return false; }
  console.log('✅ все служебные таблицы на месте');
  for (const t of TABLES) {
    const rows = await query(`select count(*) as c from ${t}`);
    console.log(`   ${t.padEnd(18)} ${rows[0][0].value}`);
  }
  return true;
}

(async () => {
  let ok = false;
  try {
    const tursoUrl = process.env.TURSO_URL;
    const tursoToken = process.env.TURSO_TOKEN;
    if (tursoUrl && tursoToken) ok = await viaTurso(tursoUrl, tursoToken);
    else ok = await viaService(arg('--url', DEFAULT_SERVICE));
  } catch (e) {
    console.log('❌ ошибка:', e.message);
    ok = false;
  }
  process.exit(ok ? 0 : 1);
})();
