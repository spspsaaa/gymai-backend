import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

/* Storage adapter.
   Primary: Turso / libSQL (works from Render, survives restarts).
   Fallback: local JSON file (so the backend still runs with zero config). */

const SCHEMA = `
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

export async function upsertUser(id, patch) {
  if (!useFile) {
    await client.execute({
      sql: `INSERT INTO users (telegram_id, username, first_name, lang, plan, coach_used, state)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET
              username=excluded.username, first_name=excluded.first_name,
              lang=excluded.lang, plan=excluded.plan,
              coach_used=excluded.coach_used, state=excluded.state,
              updated_at=datetime('now')`,
      args: [
        String(id),
        patch.username ?? null,
        patch.first_name ?? null,
        patch.lang ?? null,
        patch.plan ?? 'free',
        patch.coach_used ?? 0,
        patch.state ?? null,
      ],
    });
    return;
  }
  const db = readFile();
  const prev = db[String(id)] || {};
  db[String(id)] = { ...prev, ...patch, telegram_id: String(id) };
  writeFile(db);
}

export async function getState(id) {
  const u = await getUser(id);
  if (!u || !u.state) return null;
  try { return JSON.parse(u.state); } catch (e) { return null; }
}

export async function saveState(id, state) {
  const u = await getUser(id);
  await upsertUser(id, {
    username: u?.username ?? null,
    first_name: u?.first_name ?? null,
    lang: u?.lang ?? null,
    plan: u?.plan ?? 'free',
    coach_used: u?.coach_used ?? 0,
    state: JSON.stringify(state ?? {}),
  });
}

export async function setPlan(id, plan) {
  const u = await getUser(id);
  await upsertUser(id, {
    username: u?.username ?? null,
    first_name: u?.first_name ?? null,
    lang: u?.lang ?? null,
    plan,
    coach_used: u?.coach_used ?? 0,
    state: u?.state ?? null,
  });
}

export async function bumpCoach(id) {
  const u = await getUser(id);
  const used = Number(u?.coach_used || 0) + 1;
  await upsertUser(id, {
    username: u?.username ?? null,
    first_name: u?.first_name ?? null,
    lang: u?.lang ?? null,
    plan: u?.plan ?? 'free',
    coach_used: used,
    state: u?.state ?? null,
  });
  return used;
}
