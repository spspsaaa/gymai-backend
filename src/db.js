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
CREATE TABLE IF NOT EXISTS state_migrations (
  from_owner TEXT PRIMARY KEY,
  to_owner   TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_tg ON accounts(telegram_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_exp ON admin_sessions(expires_at);
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
    for (const col of ['name', 'phone', 'phone_verified', 'alt_email', 'alt_email_verified']) {
      try { await client.execute("ALTER TABLE accounts ADD COLUMN " + col + " TEXT"); }
      catch (e) { /* column already exists */ }
    }
    try { await client.execute("ALTER TABLE users ADD COLUMN coach_date TEXT"); }
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

  /* The counter is per calendar day: a new day resets it. */
  const today = new Date().toISOString().slice(0, 10);
  if (!useFile) {
    await client.execute({
      sql: `UPDATE users SET coach_used = 0, coach_date = ?, updated_at = datetime('now')
            WHERE telegram_id = ? AND (coach_date IS NULL OR coach_date != ?)`,
      args: [today, String(id), today],
    });
    const r = await client.execute({
      sql: `UPDATE users SET coach_used = COALESCE(coach_used, 0) + 1, coach_date = ?, updated_at = datetime('now')
            WHERE telegram_id = ? AND COALESCE(coach_used, 0) < ?`,
      args: [today, String(id), Number(limit)],
    });
    const used = Number(u?.coach_used || 0);
    if (!r.rowsAffected) return { ok: false, counted: false, used };
    return { ok: true, counted: true, used: used + 1 };
  }
  const db = readFile();
  const rec = db[String(id)] || {};
  const used = rec.coach_date === today ? Number(rec.coach_used || 0) : 0;
  if (used >= Number(limit)) return { ok: false, counted: false, used };
  db[String(id)] = { ...rec, coach_used: used + 1, coach_date: today, telegram_id: String(id) };
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
/* Deep merge of two state objects. The destination (the account) wins on
   plain-value conflicts, device-only keys are added, and arrays are unioned
   instead of one replacing the other - losing a training session because the
   same key existed on two devices would be the worst possible outcome. */
export function mergeStatesDeep(src, dst) {
  const out = { ...(dst || {}) };
  for (const k of Object.keys(src || {})) {
    const a = src[k], b = out[k];
    if (b === undefined) { out[k] = a; continue; }
    if (Array.isArray(a) && Array.isArray(b)) {
      const seen = new Set(b.map((x) => JSON.stringify(x)));
      const extra = a.filter((x) => !seen.has(JSON.stringify(x)));
      out[k] = [...b, ...extra];
      continue;
    }
    const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(a) && isObj(b)) { out[k] = mergeStatesDeep(a, b); continue; }
    /* destination wins */
  }
  return out;
}

/* One-time move of a device's state into the account. Recorded in
   state_migrations so it never runs twice for the same device - otherwise the
   account could keep being overwritten by stale device data. */
export async function migrateState(from, to) {
  const f = String(from), t = String(to);
  if (!f || !t || f === t) return false;
  if (useFile) {
    const db = readFile();
    db.__migrations = db.__migrations || {};
    if (db.__migrations[f]) return false;
    db.__migrations[f] = t;
  } else {
    const seen = await client.execute({
      sql: 'SELECT to_owner FROM state_migrations WHERE from_owner = ?',
      args: [f],
    });
    if (seen.rows && seen.rows.length) return false;
  }
  const src = await getStateByOwner(f);
  if (!src) return false;
  const dst = await getStateByOwner(t) || {};
  const merged = mergeStatesDeep(src, dst);
  await saveStateByOwner(t, merged);
  if (!useFile) {
    await client.execute({
      sql: `INSERT OR REPLACE INTO state_migrations (from_owner, to_owner, created_at) VALUES (?, ?, datetime('now'))`,
      args: [f, t],
    });
  }
  return true;
}


/* ---------- accounts: server-side profile, plan and admin ---------- */

/* The account profile is the server's source of truth. The client used to
   keep a copy in localStorage (gymai_users) which meant a device reset or a
   redeploy could lose the name, the phone binding and the tariff. */
export async function getAccountProfile(email) {
  const acc = await getAccountByEmail(email);
  if (!acc) return null;
  let name = acc.name || '';
  if (!name) {
    const u = await getUser(acc.telegram_id);
    name = (u && (u.first_name || u.username)) || String(acc.email).split('@')[0];
  }
  return {
    email: acc.email,
    name,
    phone: acc.phone || '',
    /* The file backend keeps camelCase keys, Turso uses snake_case columns.
       Read both so a value saved in one mode is visible in the other. */
    phoneVerified: (acc.phone_verified !== undefined ? Number(acc.phone_verified || 0) : (acc.phoneVerified ? 1 : 0)) ? true : false,
    altEmail: acc.alt_email || acc.altEmail || '',
    altEmailVerified: (acc.alt_email_verified !== undefined ? Number(acc.alt_email_verified || 0) : (acc.altEmailVerified ? 1 : 0)) ? true : false,
    plan: acc.plan === 'pro' ? 'pro' : 'free',
    telegramId: acc.telegram_id || null,
    created: acc.created_at || null,
  };
}

export async function updateAccountProfile(email, patch = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const fields = [];
  const args = [];
  if (patch.name !== undefined) { fields.push('name = ?'); args.push(String(patch.name).slice(0, 120)); }
  if (patch.phone !== undefined) { fields.push('phone = ?'); args.push(String(patch.phone).slice(0, 40)); }
  if (patch.phoneVerified !== undefined) { fields.push('phone_verified = ?'); args.push(patch.phoneVerified ? 1 : 0); }
  if (patch.altEmail !== undefined) { fields.push('alt_email = ?'); args.push(String(patch.altEmail).slice(0, 200)); }
  if (patch.altEmailVerified !== undefined) { fields.push('alt_email_verified = ?'); args.push(patch.altEmailVerified ? 1 : 0); }
  if (!fields.length) return getAccountProfile(e);
  if (!useFile) {
    args.push(e);
    await client.execute({
      sql: `UPDATE accounts SET ${fields.join(', ')}, updated_at = datetime('now') WHERE email = ?`,
      args,
    });
  } else {
    const db = readFile();
    db.__accounts = db.__accounts || {};
    const a = db.__accounts[e] = db.__accounts[e] || {};
    if (patch.name !== undefined) a.name = String(patch.name).slice(0, 120);
    if (patch.phone !== undefined) a.phone = String(patch.phone).slice(0, 40);
    if (patch.phoneVerified !== undefined) a.phoneVerified = !!patch.phoneVerified;
    if (patch.altEmail !== undefined) a.altEmail = String(patch.altEmail).slice(0, 200);
    if (patch.altEmailVerified !== undefined) a.altEmailVerified = !!patch.altEmailVerified;
    writeFile(db);
  }
  return getAccountProfile(e);
}

/* Grant or revoke Pro. The plan is written to the account AND to the linked
   Telegram user, because the coach limit is checked against users.plan. */
export async function setAccountPlan(email, plan) {
  const e = String(email || '').trim().toLowerCase();
  const p = plan === 'pro' ? 'pro' : 'free';
  const acc = await getAccountByEmail(e);
  if (!acc) return null;
  if (!useFile) {
    await client.execute({
      sql: "UPDATE accounts SET plan = ?, updated_at = datetime('now') WHERE email = ?",
      args: [p, e],
    });
    if (acc.telegram_id) {
      await client.execute({
        sql: "UPDATE users SET plan = ?, updated_at = datetime('now') WHERE telegram_id = ?",
        args: [p, String(acc.telegram_id)],
      });
    }
  } else {
    const db = readFile();
    db.__accounts = db.__accounts || {};
    const a = db.__accounts[e] = db.__accounts[e] || {};
    a.plan = p;
    if (acc.telegram_id) {
      db[acc.telegram_id] = { ...(db[acc.telegram_id] || {}), plan: p, telegram_id: String(acc.telegram_id) };
    }
    writeFile(db);
  }
  return p;
}

/* Every account on the server, for the admin panel. */
export async function listAccounts() {
  if (!useFile && client) {
    /* The accounts table gained columns over time (name, phone, alt_email...).
       A hard-coded SELECT breaks the whole admin panel if one ALTER never
       landed on an old database, so the column set is checked first and the
       query is built from what actually exists. */
    let cols = { email: 1, plan: 1, telegram_id: 1, created_at: 1, updated_at: 1 };
    try {
      const pr = await client.execute("PRAGMA table_info(accounts)");
      const names = (pr.rows || []).map((r) => r.name);
      if (names.length) {
        cols = {};
        for (const n of names) cols[n] = 1;
      }
    } catch (e) {
      console.warn('[db] table_info(accounts) failed, using fallback columns:', e.message);
    }

    const wanted = ['email', 'name', 'phone', 'phone_verified', 'alt_email', 'alt_email_verified',
      'plan', 'telegram_id', 'created_at', 'updated_at'];
    const sel = wanted.filter((c) => cols[c]);
    if (!sel.includes('email')) sel.unshift('email');

    let rows = [];
    try {
      const r = await client.execute(`SELECT ${sel.join(', ')} FROM accounts ORDER BY created_at DESC`);
      rows = r.rows || [];
    } catch (e) {
      console.error('[db] listAccounts select failed:', e.message);
      try {
        const r = await client.execute({ sql: 'SELECT * FROM accounts ORDER BY created_at DESC' });
        rows = r.rows || [];
      } catch (e2) { console.error('[db] listAccounts fallback failed:', e2.message); }
    }

    /* The "seen" flag is only a hint, so a broken subquery must not take the
       whole list down. */
    const seen = {};
    try {
      const ur = await client.execute('SELECT telegram_id FROM users');
      for (const u of ur.rows || []) if (u.telegram_id) seen[String(u.telegram_id)] = true;
    } catch (e) {
      console.warn('[db] listAccounts users lookup skipped:', e.message);
    }

    return rows.map((row) => ({
      email: row.email,
      name: row.name || '',
      phone: row.phone || '',
      phoneVerified: Number(row.phone_verified || 0) ? true : false,
      altEmail: row.alt_email || '',
      altEmailVerified: Number(row.alt_email_verified || 0) ? true : false,
      plan: row.plan === 'pro' ? 'pro' : 'free',
      telegramId: row.telegram_id || null,
      created: row.created_at || null,
      updated: row.updated_at || null,
      seen: row.telegram_id ? !!seen[String(row.telegram_id)] : false,
    }));
  }
  const db = readFile();
  const accs = db.__accounts || {};
  return Object.keys(accs).map((e) => {
    const a = accs[e] || {};
    return {
      email: e,
      name: a.name || '',
      phone: a.phone || '',
      phoneVerified: !!(a.phoneVerified || Number(a.phone_verified || 0)),
      altEmail: a.altEmail || a.alt_email || '',
      altEmailVerified: !!(a.altEmailVerified || Number(a.alt_email_verified || 0)),
      plan: a.plan === 'pro' ? 'pro' : 'free',
      telegramId: a.telegram_id || null,
      created: a.created || null,
      updated: null,
      seen: !!db[a.telegram_id],
    };
  });
}

/* ---- admin sessions: the secret is exchanged for a token, so the secret
   itself never has to live in the shipped client ---- */
export async function saveAdminSession(token, expiresAt) {
  if (!useFile) {
    await client.execute({
      sql: 'INSERT OR REPLACE INTO admin_sessions (token, expires_at) VALUES (?, ?)',
      args: [String(token), String(expiresAt)],
    });
    return;
  }
  const db = readFile();
  db.__adminSessions = db.__adminSessions || {};
  db.__adminSessions[String(token)] = String(expiresAt);
  writeFile(db);
}

export async function getAdminSession(token) {
  const t = String(token || '');
  if (!t) return null;
  if (!useFile) {
    const r = await client.execute({
      sql: 'SELECT expires_at FROM admin_sessions WHERE token = ?',
      args: [t],
    });
    const row = r.rows[0];
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      await client.execute({ sql: 'DELETE FROM admin_sessions WHERE token = ?', args: [t] });
      return null;
    }
    return { token: t, expiresAt: row.expires_at };
  }
  const db = readFile();
  const exp = (db.__adminSessions || {})[t];
  if (!exp) return null;
  if (new Date(exp).getTime() < Date.now()) return null;
  return { token: t, expiresAt: exp };
}

export async function deleteAdminSession(token) {
  const t = String(token || '');
  if (!t) return;
  if (!useFile) {
    await client.execute({ sql: 'DELETE FROM admin_sessions WHERE token = ?', args: [t] });
    return;
  }
  const db = readFile();
  db.__adminSessions = db.__adminSessions || {};
  delete db.__adminSessions[t];
  writeFile(db);
}

/* ---- coach chat history: kept on the server, keyed by the data owner ---- */
const CHAT_MAX = 200;

export async function getChatHistory(owner) {
  const o = String(owner || '');
  if (!o) return [];
  const state = await getStateByOwner(o);
  const list = state && state.gymai_chat;
  return Array.isArray(list) ? list.slice(-CHAT_MAX) : [];
}

/* Append the exchange and keep only the tail, so the row cannot grow forever. */
export async function appendChat(owner, messages) {
  const o = String(owner || '');
  if (!o || !Array.isArray(messages) || !messages.length) return [];
  const old = await getChatHistory(o);
  const merged = [...old, ...messages].slice(-CHAT_MAX);
  await mergeStateByOwner(o, { gymai_chat: merged });
  return merged;
}

/* Free-tier usage is counted per calendar day on the server. */
export async function coachUsage(id) {
  const u = await getUser(id);
  const today = new Date().toISOString().slice(0, 10);
  if (!u) return { used: 0, date: today };
  if (u.coach_date !== today) return { used: 0, date: today };
  return { used: Number(u.coach_used || 0), date: today };
}


/* Delete an account together with its sessions and state. */
export async function deleteAccount(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  if (!useFile) {
    await client.execute({ sql: 'DELETE FROM accounts WHERE email = ?', args: [e] });
    await client.execute({ sql: 'DELETE FROM account_sessions WHERE email = ?', args: [e] });
    await client.execute({ sql: 'DELETE FROM states WHERE owner = ?', args: ['acct:' + e] });
    return true;
  }
  const db = readFile();
  db.__accounts = db.__accounts || {};
  db.__accountSessions = db.__accountSessions || {};
  db.__states = db.__states || {};
  delete db.__accounts[e];
  Object.keys(db.__accountSessions).forEach((k) => {
    if (db.__accountSessions[k] && db.__accountSessions[k].email === e) delete db.__accountSessions[k];
  });
  delete db.__states['acct:' + e];
  writeFile(db);
  return true;
}

/* Reports the real shape of the database: which tables and columns exist and
   how many rows they hold. Used to diagnose the admin panel over HTTP. */
export async function dbDiag() {
  const out = { mode: !useFile && client ? 'libsql' : 'file', tables: {}, counts: {} };
  if (!client) {
    const db = readFile();
    out.counts.accounts = Object.keys(db.__accounts || {}).length;
    out.counts.users = Object.keys(db).filter((k) => !k.startsWith('__')).length;
    return out;
  }
  try {
    const m = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    out.tables.list = (m.rows || []).map((r) => r.name);
  } catch (e) { out.tables.error = e.message; }
  try {
    const r = await client.execute('SELECT email, name, phone, phone_verified, alt_email, alt_email_verified, plan, telegram_id, created_at, updated_at FROM accounts ORDER BY created_at DESC');
    out.listAccounts = { ok: true, count: (r.rows || []).length, first: (r.rows || [])[0] || null };
  } catch (e) { out.listAccounts = { ok: false, error: e.message }; }
  for (const t of ['accounts', 'users', 'admin_sessions', 'states']) {
    try {
      const ti = await client.execute(`PRAGMA table_info(${t})`);
      out.tables[t] = (ti.rows || []).map((r) => r.name);
    } catch (e) { out.tables[t] = 'error: ' + e.message; }
    try {
      const c = await client.execute(`SELECT COUNT(*) AS n FROM ${t}`);
      out.counts[t] = Number((c.rows && c.rows[0] && c.rows[0].n) || 0);
    } catch (e) { out.counts[t] = 'error: ' + e.message; }
  }
  return out;
}
