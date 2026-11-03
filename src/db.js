import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

/* Storage adapter.
   Primary: Turso / libSQL (works from Render, survives restarts).
   Fallback: local JSON file (so the backend still runs with zero config). */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  telegram_id TEXT,
  user_json   TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username   TEXT,
  first_name TEXT,
  lang       TEXT,
  plan       TEXT DEFAULT 'free',
  coach_used INTEGER DEFAULT 0,
  state      TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

const COLS = ['username', 'first_name', 'lang', 'plan', 'coach_used', 'state'];

let client = null;
let useFile = false;
const FILE = path.join(process.cwd(), 'data', 'gymai.json');

function ensureDir() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch (e) {}
}
function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}
function writeFile(db) {
  ensureDir();
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } catch (e) {}
}

export async function init() {
  const url = process.env.TURSO_URL;
  const token = process.env.TURSO_TOKEN;
  if (url && token) {
    client = createClient({ url, authToken: token });
    await client.executeMultiple(SCHEMA);
    console.log('[db] libSQL connected:', url);
  } else {
    useFile = true;
    ensureDir();
    console.log('[db] using local file fallback (no TURSO_URL/TURSO_TOKEN)');
  }
}

export async function getUser(id) {
  if (!useFile) {
    const r = await client.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [String(id)],
    });
    return r.rows[0] || null;
  }
  const db = readFile();
  return db[String(id)] || null;
}

/* True upsert-patch: only the fields present in `patch` are written,
   everything else is left untouched (no read-modify-write races). */
export async function upsertUser(id, patch = {}) {
  const keys = COLS.filter((k) => patch[k] !== undefined);
  if (!useFile) {
    const cols = ['telegram_id', ...keys];
    const marks = cols.map(() => '?').join(', ');
    const sets = keys.map((k) => `${k}=excluded.${k}`).concat(["updated_at=datetime('now')"]).join(', ');
    await client.execute({
      sql: `INSERT INTO users (${cols.join(', ')}) VALUES (${marks})
            ON CONFLICT(telegram_id) DO UPDATE SET ${sets}`,
      args: [String(id), ...keys.map((k) => patch[k])],
    });
    return;
  }
  const db = readFile();
  const picked = {};
  for (const k of keys) picked[k] = patch[k];
  db[String(id)] = { plan: 'free', coach_used: 0, ...(db[String(id)] || {}), ...picked, telegram_id: String(id) };
  writeFile(db);
}

export async function getState(id) {
  const u = await getUser(id);
  if (!u || !u.state) return null;
  try { return JSON.parse(u.state); } catch (e) { return null; }
}

export async function saveState(id, state) {
  await upsertUser(id, { state: JSON.stringify(state ?? {}) });
}

export async function setPlan(id, plan) {
  await upsertUser(id, { plan });
}

/* Atomically reserve one AI-coach request for a free user.
   Returns { ok, counted, used }. Pro users are never counted.
   If the AI call fails afterwards, call refundCoach(). */
export async function reserveCoach(id, limit) {
  let u = await getUser(id);
  if (!u) {
    await upsertUser(id, { plan: 'free', coach_used: 0 });
    u = await getUser(id);
  }
  if (u && u.plan === 'pro') return { ok: true, counted: false, used: Number(u.coach_used || 0) };

  if (!useFile) {
    const r = await client.execute({
      sql: `UPDATE users SET coach_used = COALESCE(coach_used, 0) + 1, updated_at = datetime('now')
            WHERE telegram_id = ? AND COALESCE(coach_used, 0) < ?`,
      args: [String(id), Number(limit)],
    });
    const used = Number(u?.coach_used || 0);
    if (!r.rowsAffected) return { ok: false, counted: false, used };
    return { ok: true, counted: true, used: used + 1 };
  }
  const db = readFile();
  const rec = db[String(id)] || {};
  const used = Number(rec.coach_used || 0);
  if (used >= Number(limit)) return { ok: false, counted: false, used };
  db[String(id)] = { ...rec, coach_used: used + 1, telegram_id: String(id) };
  writeFile(db);
  return { ok: true, counted: true, used: used + 1 };
}

export async function refundCoach(id) {
  if (!useFile) {
    await client.execute({
      sql: `UPDATE users SET coach_used = MAX(COALESCE(coach_used, 0) - 1, 0) WHERE telegram_id = ?`,
      args: [String(id)],
    });
    return;
  }
  const db = readFile();
  const rec = db[String(id)];
  if (!rec) return;
  rec.coach_used = Math.max(Number(rec.coach_used || 0) - 1, 0);
  writeFile(db);
}

/* ---- persistent sessions (survive Render restarts / free-plan sleeps) ---- */
export async function saveSession(token, user) {
  if (!useFile) {
    await client.execute({
      sql: 'INSERT OR REPLACE INTO sessions (token, telegram_id, user_json) VALUES (?, ?, ?)',
      args: [token, String(user.id), JSON.stringify(user)],
    });
    return;
  }
  const db = readFile();
  db.__sessions = db.__sessions || {};
  db.__sessions[token] = user;
  writeFile(db);
}

export async function getSession(token) {
  if (!useFile) {
    const r = await client.execute({
      sql: 'SELECT user_json FROM sessions WHERE token = ?',
      args: [String(token)],
    });
    if (!r.rows[0]) return null;
    try { return JSON.parse(r.rows[0].user_json); } catch (e) { return null; }
  }
  const db = readFile();
  return (db.__sessions || {})[String(token)] || null;
}
