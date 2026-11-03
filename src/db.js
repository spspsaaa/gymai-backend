import { createClient } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
CREATE TABLE IF NOT EXISTS accounts (
  email       TEXT PRIMARY KEY,
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  telegram_id TEXT,
  plan        TEXT DEFAULT 'free',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS states (
  owner       TEXT PRIMARY KEY,
  state       TEXT,
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  telegram_id TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  expires_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_tg ON accounts(telegram_id);
CREATE INDEX IF NOT EXISTS idx_acct_sess_email ON account_sessions(email);
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
    try { await client.execute("ALTER TABLE accounts ADD COLUMN plan TEXT DEFAULT 'free'"); }
    catch (e) { /* column already exists */ }
    try {
      await client.execute(
        "INSERT OR IGNORE INTO states (owner, state, updated_at) " +
        "SELECT 'tg:' || telegram_id, state, updated_at FROM users WHERE state IS NOT NULL AND state != ''",
      );
    } catch (e) { console.warn('[db] legacy state migration skipped:', e.message); }
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

/* Merge a patch into the stored state instead of replacing it.
   The frontend pushes ONE key at a time (debounced), so a full replace wiped
   every other key on the server. json_set does the merge inside a single
   UPDATE, so two devices writing different keys cannot lose each other. */
const SAFE_KEY = /^[A-Za-z0-9_]+$/;

export async function mergeState(id, patch) {
  const keys = Object.keys(patch || {}).filter(
    (k) => SAFE_KEY.test(k) && patch[k] !== undefined && patch[k] !== null,
  );
  if (!keys.length) return;
  if (!useFile) {
    const sets = keys.map((k) => `'$."${k}"', json(?)`).join(', ');
    const args = keys.map((k) => JSON.stringify(patch[k]));
    await client.execute({
      sql: `UPDATE users SET state = json_set(COALESCE(state, '{}'), ${sets}), updated_at = datetime('now')
            WHERE telegram_id = ?`,
      args: [...args, String(id)],
    });
    return;
  }
  const db = readFile();
  const rec = db[String(id)] || { telegram_id: String(id) };
  let cur = {};
  try { cur = JSON.parse(rec.state || '{}'); } catch (e) { cur = {}; }
  for (const k of keys) cur[k] = patch[k];
  rec.state = JSON.stringify(cur);
  rec.updated_at = new Date().toISOString();
  db[String(id)] = rec;
  writeFile(db);
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


/* ---------- accounts: email + password, hashed server-side ---------- */

export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { hash: h, salt: s };
}

export function verifyPassword(password, hash, salt) {
  try {
    const h = crypto.scryptSync(String(password), String(salt), 64).toString('hex');
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(String(hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

export async function getAccountByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  if (!useFile) {
    const r = await client.execute({ sql: 'SELECT * FROM accounts WHERE email = ?', args: [e] });
    return r.rows[0] || null;
  }
  const db = readFile();
  return (db.__accounts || {})[e] || null;
}

export async function getAccountByTelegram(telegramId) {
  const id = String(telegramId || '');
  if (!id) return null;
  if (!useFile) {
    const r = await client.execute({ sql: 'SELECT * FROM accounts WHERE telegram_id = ?', args: [id] });
    return r.rows[0] || null;
  }
  const db = readFile();
  const accs = db.__accounts || {};
  for (const k in accs) if (String(accs[k].telegram_id) === id) return accs[k];
  return null;
}

export async function createAccount(email, password, telegramId) {
  const e = String(email || '').trim().toLowerCase();
  const { hash, salt } = hashPassword(password);
  if (!useFile) {
    await client.execute({
      sql: `INSERT INTO accounts (email, pw_hash, pw_salt, telegram_id) VALUES (?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
              pw_hash = excluded.pw_hash, pw_salt = excluded.pw_salt,
              telegram_id = COALESCE(excluded.telegram_id, accounts.telegram_id),
              updated_at = datetime('now')`,
      args: [e, hash, salt, telegramId ? String(telegramId) : null],
    });
  } else {
    const db = readFile();
    db.__accounts = db.__accounts || {};
    const prev = db.__accounts[e] || {};
    db.__accounts[e] = {
      email: e, pw_hash: hash, pw_salt: salt,
      telegram_id: telegramId ? String(telegramId) : (prev.telegram_id || null),
      created_at: prev.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    writeFile(db);
  }
  return getAccountByEmail(e);
}

export async function linkAccountToTelegram(email, telegramId) {
  const e = String(email || '').trim().toLowerCase();
  if (!useFile) {
    await client.execute({
      sql: "UPDATE accounts SET telegram_id = ?, updated_at = datetime('now') WHERE email = ?",
      args: [String(telegramId), e],
    });
    return;
  }
  const db = readFile();
  db.__accounts = db.__accounts || {};
  if (db.__accounts[e]) {
    db.__accounts[e].telegram_id = String(telegramId);
    db.__accounts[e].updated_at = new Date().toISOString();
  }
  writeFile(db);
}

export async function saveAccountSession(token, email, telegramId, expiresAt) {
  const e = String(email || '').trim().toLowerCase();
  if (!useFile) {
    await client.execute({
      sql: 'INSERT OR REPLACE INTO account_sessions (token, email, telegram_id, expires_at) VALUES (?, ?, ?, ?)',
      args: [token, e, telegramId ? String(telegramId) : null, expiresAt || null],
    });
    return;
  }
  const db = readFile();
  db.__acctSessions = db.__acctSessions || {};
  db.__acctSessions[token] = { email: e, telegram_id: telegramId || null, expires_at: expiresAt || null };
  writeFile(db);
}

export async function getAccountSession(token) {
  const t = String(token || '');
  if (!t) return null;
  if (!useFile) {
    const r = await client.execute({ sql: 'SELECT * FROM account_sessions WHERE token = ?', args: [t] });
    const row = r.rows[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      await deleteAccountSession(t);
      return null;
    }
    return row;
  }
  const db = readFile();
  const s = (db.__acctSessions || {})[t];
  if (!s) return null;
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) {
    delete db.__acctSessions[t]; writeFile(db); return null;
  }
  return s;
}

export async function deleteAccountSession(token) {
  const t = String(token || '');
  if (!useFile) {
    await client.execute({ sql: 'DELETE FROM account_sessions WHERE token = ?', args: [t] });
    return;
  }
  const db = readFile();
  if (db.__acctSessions && db.__acctSessions[t]) { delete db.__acctSessions[t]; writeFile(db); }
}


/* ---------- owner-keyed state ----------
   The owner is the identity that owns the data:
     'tg:<telegram_id>'  -> a device that has not signed in with an email
     'acct:<email>'      -> an account, which follows the user across devices
   State lives in its own table so it is independent from the users rows
   (which are keyed by telegram id). */

export async function getStateByOwner(owner) {
  const o = String(owner);
  if (!o) return null;
  if (!useFile) {
    const r = await client.execute({ sql: 'SELECT state FROM states WHERE owner = ?', args: [o] });
    const row = r.rows[0];
    if (!row || !row.state) return null;
    try { return JSON.parse(row.state); } catch (e) { return null; }
  }
  const db = readFile();
  db.__states = db.__states || {};
  const raw = db.__states[o];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function saveStateByOwner(owner, state) {
  const o = String(owner);
  if (!o) return;
  const payload = JSON.stringify(state ?? {});
  if (!useFile) {
    await client.execute({
      sql: `INSERT INTO states (owner, state, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(owner) DO UPDATE SET state = excluded.state, updated_at = datetime('now')`,
      args: [o, payload],
    });
    return;
  }
  const db = readFile();
  db.__states = db.__states || {};
  db.__states[o] = payload;
  writeFile(db);
}

export async function mergeStateByOwner(owner, patch) {
  const o = String(owner);
  const keys = Object.keys(patch || {}).filter(
    (k) => SAFE_KEY.test(k) && patch[k] !== undefined && patch[k] !== null,
  );
  if (!o || !keys.length) return;
  if (!useFile) {
    /* Two separate statements on purpose. A single INSERT .. ON CONFLICT DO
       UPDATE that repeats the json_set() list needs every placeholder bound
       twice, which broke the binding count and made every write fail with a
       500. Ensure the row exists, then merge the keys into it. */
    const sets = keys.map((k) => `'$."${k}"', json(?)`).join(', ');
    const args = keys.map((k) => JSON.stringify(patch[k]));
    await client.execute({
      sql: `INSERT OR IGNORE INTO states (owner, state, updated_at)
            VALUES (?, json_set('{}'), datetime('now'))`,
      args: [o],
    });
    await client.execute({
      sql: `UPDATE states
            SET state = json_set(COALESCE(state, '{}'), ${sets}), updated_at = datetime('now')
            WHERE owner = ?`,
      args: [...args, o],
    });
    return;
  }
  const db = readFile();
  db.__states = db.__states || {};
  let cur = {};
  try { cur = JSON.parse(db.__states[o] || '{}'); } catch (e) { cur = {}; }
  for (const k of keys) cur[k] = patch[k];
  db.__states[o] = JSON.stringify(cur);
  writeFile(db);
}

/* Copy state from one owner to another (device -> account migration).
   Keys already present in the target win, so an account is never
   overwritten by an older copy of the device state. */
export async function migrateState(from, to) {
  const f = String(from), t = String(to);
  if (!f || !t || f === t) return;
  const src = await getStateByOwner(f);
  if (!src) return;
  const dst = await getStateByOwner(t) || {};
  const merged = { ...src, ...dst };
  await saveStateByOwner(t, merged);
}
