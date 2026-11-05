#!/usr/bin/env node
/* Checks that the backend is really talking to Turso / libSQL and that the
   tables are there. Read-only.

   Usage:  TURSO_URL=libsql://... TURSO_TOKEN=... node scripts/dbcheck.js
   Or point it at a live service:  node scripts/dbcheck.js --url http://localhost:3000 */

const TABLES = ['users', 'accounts', 'states', 'sessions', 'account_sessions', 'admin_sessions', 'state_migrations'];

async function checkTurso() {
  const url = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  if (!url || !token) {
    console.log('⚠️  TURSO_URL/TURSO_TOKEN не заданы — сервер работает на локальном файле,');
    console.log('   данные не переживут рестарт. Это допустимо только для локальной разработки.');
    return false;
  }
  const host = url.replace(/^libsql:\/\//, '').replace(/^https?:\/\//, '');
  const res = await fetch(`https://${host}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ type: 'execute', stmt: { sql: "select name from sqlite_master where type='table'" } }],
    }),
  });
  if (!res.ok) { console.log('❌ Turso вернул', res.status); return false; }
  const data = await res.json();
  const got = (data.results?.[0]?.response?.result?.rows || []).map((r) => r[0].value);
  const missing = TABLES.filter((t) => !got.includes(t));
  console.log('✅ Turso отвечает:', host);
  console.log('   таблиц в базе:', got.length);
  if (missing.length) { console.log('❌ нет таблиц:', missing.join(', ')); return false; }
  console.log('✅ все служебные таблицы на месте');
  for (const t of TABLES) {
    const r = await fetch(`https://${host}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: `select count(*) as c from ${t}` } }] }),
    });
    const d = await r.json();
    const c = d.results?.[0]?.response?.result?.rows?.[0]?.[0]?.value;
    console.log(`   ${t.padEnd(18)} ${c}`);
  }
  return true;
}

(async () => {
  const ok = await checkTurso();
  process.exit(ok ? 0 : 1);
})();
