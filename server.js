import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import {
  init, getUser, upsertUser, saveState, mergeState, setPlan, getState,
  saveSession, getSession, reserveCoach, refundCoach,
  hashPassword, verifyPassword, getAccountByEmail, getAccountByTelegram,
  createAccount, linkAccountToTelegram,
  saveAccountSession, getAccountSession, deleteAccountSession,
  getStateByOwner, saveStateByOwner, mergeStateByOwner, migrateState,
} from './src/db.js';
import { verifyInitData, userFromInitDataUnverified } from './src/telegram.js';
import { askCoach } from './src/ai.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const FREE_COACH_LIMIT = Number(process.env.FREE_COACH_LIMIT || 20);
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED === '1';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://gym-ai-3f0d63ky.agent.mira.tg';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Resolve a Telegram user from initData.
   1) verified HMAC signature (normal path);
   2) no BOT_TOKEN configured (local dev) -> trust the payload;
   3) ALLOW_UNVERIFIED=1 -> trust the payload (temporary escape hatch, e.g.
      initData issued by an older bot token). Turn it off when not needed:
      with it on, anyone can impersonate any Telegram id. */
function resolveInitUser(initData) {
  if (!initData) return null;
  const v = verifyInitData(initData, BOT_TOKEN);
  if (v && v.id) return v;

  if (!BOT_TOKEN) return userFromInitDataUnverified(initData);

  if (ALLOW_UNVERIFIED) {
    const u = userFromInitDataUnverified(initData);
    if (u) {
      console.warn('[auth] initData accepted WITHOUT signature verification (ALLOW_UNVERIFIED=1) id=' + u.id);
      return u;
    }
  }
  return null;
}

/* ---- Telegram bot: reply with an inline button that opens the mini app ---- */
async function telegramCall(method, payload) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(10000),
    });
    return await r.json().catch(() => null);
  } catch (e) {
    console.warn('[tg]', method, 'failed', String(e).slice(0, 120));
    return null;
  }
}

const APP_BTN = {
  reply_markup: {
    inline_keyboard: [[{ text: 'Открыть GYM AI', web_app: { url: WEBAPP_URL } }]],
  },
};

const WELCOME_TEXT =
  'Привет! Я GYM AI — твой тренировочный помощник.\n\n' +
  'В приложении: план тренировок, журнал, прогресс и AI-тренер, которому можно задать любой вопрос.\n\n' +
  'Нажми кнопку ниже, чтобы начать.';

const FALLBACK_TEXT = 'Нажми кнопку ниже, чтобы открыть мини-апп и начать тренировку.';

app.post('/api/tg/webhook', async (req, res) => {
  const secret = process.env.TG_WEBHOOK_SECRET || '';
  if (secret && !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', secret)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const up = req.body || {};
    const msg = up.message || up.edited_message;
    if (msg && msg.chat && msg.chat.type === 'private') {
      const chatId = msg.chat.id;
      const text = String(msg.text || '').trim();
      if (/^\/start/i.test(text)) {
        if (msg.from) {
          const id = String(msg.from.id);
          if (!(await getUser(id))) {
            await upsertUserSafe(id, {
              username: msg.from.username || '',
              first_name: msg.from.first_name || '',
              lang: msg.from.language_code || '',
            });
          }
        }
        await telegramCall('sendMessage', {
          chat_id: chatId, text: WELCOME_TEXT, disable_web_page_preview: true, ...APP_BTN,
        });
      } else if (text) {
        await telegramCall('sendMessage', { chat_id: chatId, text: FALLBACK_TEXT, ...APP_BTN });
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    console.warn('[tg] webhook error', String(e).slice(0, 200));
    return res.status(200).json({ ok: true });
  }
});

async function upsertUserSafe(id, patch) {
  try { await upsertUser(id, patch); } catch (e) { console.warn('[db] upsert failed', String(e).slice(0, 120)); }
}

/* ---- sessions (persisted in the DB, cached in memory) ---- */
const sessions = new Map(); // token -> telegram user

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function tokenFrom(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function userFromToken(req) {
  const t = tokenFrom(req);
  if (!t) return null;
  if (sessions.has(t)) return sessions.get(t);
  const u = await getSession(t);
  if (u) sessions.set(t, u);
  return u || null;
}

/* Resolve the user: Bearer token first, then initData as fallback. */
async function resolveUser(req) {
  const u = await userFromToken(req);
  if (u) return u;

  const body = req.body || {};
  const initData = body.initData || req.headers['x-init-data'] || '';
  if (!initData) {
    console.warn('[auth] no initData and no valid token');
    return null;
  }
  const ru = resolveInitUser(initData);
  if (!ru) console.warn('[auth] initData rejected, len=' + String(initData).length);
  return ru;
}

app.get('/health', (req, res) => {
  res.json({ ok: true, ai: !!process.env.AI_API_KEY, bot: !!BOT_TOKEN });
});

app.post('/api/auth', async (req, res) => {
  try {
    const { initData = '' } = req.body || {};
    const u = resolveInitUser(initData);
    if (!u || !u.id) return res.status(401).json({ error: 'bad_init_data' });

    let rec = await getUser(u.id);
    if (!rec) {
      await upsertUser(u.id, {
        username: u.username, first_name: u.first_name, lang: u.lang,
        plan: 'free', coach_used: 0, state: null,
      });
      rec = await getUser(u.id);
    } else if (u.username !== rec.username || u.first_name !== rec.first_name) {
      await upsertUser(u.id, { username: u.username, first_name: u.first_name });
    }

    const token = newToken();
    sessions.set(token, u);
    await saveSession(token, u);
    res.json({
      token,
      user: {
        id: u.id,
        username: u.username,
        first_name: u.first_name,
        lang: rec?.lang || u.lang || 'ru',
        plan: rec?.plan || 'free',
        coach_used: Number(rec?.coach_used || 0),
      },
    });
  } catch (e) {
    console.error('[auth]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* Resolve who owns the data.
   Priority:
     1) an account token (acct_...) -> owner 'acct:<email>'  (follows the user
        across devices — this is what makes a device change keep the data);
     2) otherwise the Telegram session -> owner 'tg:<telegram_id>'.
   When an account signs in on a device that already has data, the device's
   state is migrated into the account once, so nothing is lost. */
async function resolveOwner(req) {
  const t = tokenFrom(req);
  if (t && t.startsWith('acct_')) {
    const s = await getAccountSession(t);
    if (s) {
      const acc = await getAccountByEmail(s.email);
      if (acc) {
        const owner = 'acct:' + String(s.email).toLowerCase();
        /* The device may already hold data under 'tg:<id>' from before the
           account existed. Move it into the account once, so signing in does
           not look like losing everything. migrateState is guarded internally
           and merges, so calling it on every request is safe. */
        if (s.telegram_id) {
          try {
            await migrateState('tg:' + String(s.telegram_id), owner);
          } catch (e) { console.warn('[owner] migration failed:', e.message); }
        }
        return { owner, account: acc, token: t, telegramId: s.telegram_id };
      }
    }
  }
  const u = await resolveUser(req);
  if (!u) return null;
  const tgOwner = 'tg:' + String(u.id);
  const acc = await getAccountByTelegram(u.id);
  if (acc) {
    const owner = 'acct:' + String(acc.email).toLowerCase();
    try {
      await migrateState(tgOwner, owner);
    } catch (e) { console.warn('[owner] migration failed:', e.message); }
    return { owner, account: acc, token: null, telegramId: String(u.id) };
  }
  return { owner: tgOwner, account: null, token: null, telegramId: String(u.id) };
}

app.get('/api/state', async (req, res) => {
  try {
    const o = await resolveOwner(req);
    if (!o) return res.status(401).json({ error: 'unauthorized' });
    const state = await getStateByOwner(o.owner);
    res.json({ state: state || {} });
  } catch (e) {
    console.error('[state:get]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    const o = await resolveOwner(req);
    if (!o) return res.status(401).json({ error: 'unauthorized' });
    const { state } = req.body || {};
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({ error: 'bad_state' });
    }
    /* Merge, don't replace: the client pushes one key at a time. */
    await mergeStateByOwner(o.owner, state);
    res.json({ ok: true });
  } catch (e) {
    console.error('[state:put]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* Full replace — used by "reset my data", never by the normal sync path. */
app.put('/api/state/replace', async (req, res) => {
  try {
    const o = await resolveOwner(req);
    if (!o) return res.status(401).json({ error: 'unauthorized' });
    const { state } = req.body || {};
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({ error: 'bad_state' });
    }
    await saveStateByOwner(o.owner, state);
    res.json({ ok: true });
  } catch (e) {
    console.error('[state:replace]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/* ---------- accounts: register / login, bound to the Telegram id ---------- */

const ACCOUNT_SESSION_DAYS = 90;

function accountToken() {
  return crypto.randomBytes(24).toString('hex');
}

function accountExpiry() {
  return new Date(Date.now() + ACCOUNT_SESSION_DAYS * 86400000).toISOString();
}

/* Resolve the account from an account token (Bearer acct_...), or fall back
   to the Telegram session so the mini app keeps working without a password. */
async function resolveAccount(req) {
  const t = tokenFrom(req);
  if (t && t.startsWith('acct_')) {
    const s = await getAccountSession(t);
    if (s) {
      const acc = await getAccountByEmail(s.email);
      if (acc) return { account: acc, token: t, telegramId: s.telegram_id };
    }
  }
  const u = await resolveUser(req);
  if (!u) return null;
  const acc = await getAccountByTelegram(u.id);
  if (!acc) return null;
  return { account: acc, token: null, telegramId: String(u.id) };
}

app.post('/api/account/register', async (req, res) => {
  try {
    const { email = '', password = '', initData = '' } = req.body || {};
    const e = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) {
      return res.status(400).json({ error: 'bad_email' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'weak_password' });
    }
    const existing = await getAccountByEmail(e);
    if (existing) return res.status(409).json({ error: 'email_taken' });

    let telegramId = null;
    const u = resolveInitUser(initData);
    if (u && u.id) telegramId = String(u.id);

    await createAccount(e, password, telegramId);
    const owner = 'acct:' + e;
    if (telegramId) {
      /* Data collected on this device before registration stays with the user. */
      try {
        await migrateState('tg:' + String(telegramId), owner);
      } catch (e) { console.warn('[owner] migration on register failed:', e.message); }
    }
    const ownerAcc = 'acct:' + e;
    if (telegramId) {
      /* Signing in on a device that already had local data: merge it in. */
      try {
        await migrateState('tg:' + String(telegramId), ownerAcc);
      } catch (e) { console.warn('[owner] migration on login failed:', e.message); }
    }
    const token = 'acct_' + accountToken();
    await saveAccountSession(token, e, telegramId, accountExpiry());
    res.json({ ok: true, token, email: e, telegram_id: telegramId });
  } catch (e) {
    console.error('[account:register]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/account/login', async (req, res) => {
  try {
    const { email = '', password = '', initData = '' } = req.body || {};
    const e = String(email).trim().toLowerCase();
    const acc = await getAccountByEmail(e);
    if (!acc || !verifyPassword(password, acc.pw_hash, acc.pw_salt)) {
      return res.status(401).json({ error: 'bad_credentials' });
    }
    let telegramId = acc.telegram_id;
    const u = resolveInitUser(initData);
    if (u && u.id) {
      telegramId = String(u.id);
      if (!acc.telegram_id || String(acc.telegram_id) !== telegramId) {
        await linkAccountToTelegram(e, telegramId);
      }
    }
    const ownerAcc = 'acct:' + e;
    if (telegramId) {
      /* Signing in on a device that already had local data: merge it in. */
      try {
        await migrateState('tg:' + String(telegramId), ownerAcc);
      } catch (e) { console.warn('[owner] migration on login failed:', e.message); }
    }
    const token = 'acct_' + accountToken();
    await saveAccountSession(token, e, telegramId, accountExpiry());
    res.json({ ok: true, token, email: e, telegram_id: telegramId });
  } catch (e) {
    console.error('[account:login]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/account/me', async (req, res) => {
  try {
    const a = await resolveAccount(req);
    if (!a) return res.status(401).json({ error: 'unauthorized' });
    res.json({
      email: a.account.email,
      telegram_id: a.telegramId,
      created_at: a.account.created_at,
    });
  } catch (e) {
    console.error('[account:me]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/account/logout', async (req, res) => {
  try {
    const t = tokenFrom(req);
    if (t && t.startsWith('acct_')) await deleteAccountSession(t);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/coach', async (req, res) => {
  const u = await resolveUser(req);
  if (!u) {
    console.warn('[coach] unauthorized: hasToken=' + !!tokenFrom(req));
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Reserve the request atomically BEFORE calling the AI, refund on failure.
  let reservation;
  try {
    reservation = await reserveCoach(u.id, FREE_COACH_LIMIT);
  } catch (e) {
    console.error('[coach] reserve', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
  if (!reservation.ok) {
    return res.status(402).json({ error: 'limit_reached', used: reservation.used, limit: FREE_COACH_LIMIT });
  }

  try {
    let state = null;
    try {
      const o = await resolveOwner(req);
      state = o ? await getStateByOwner(o.owner) : null;
    } catch (e) { state = null; }
    const reply = await askCoach({
      message: req.body?.message,
      lang: req.body?.lang || u.lang || 'ru',
      history: req.body?.history || [],
      state,
      user: u,
    });
    res.json({ reply });
  } catch (e) {
    if (reservation.counted) await refundCoach(u.id).catch(() => {});
    console.error('[coach]', e.message);
    res.status(500).json({ error: 'ai_failed' });
  }
});

/* Admin: grant or revoke Pro. */
app.post('/api/admin/plan', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || '';
  if (!process.env.ADMIN_SECRET || !safeEqual(secret, process.env.ADMIN_SECRET)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { telegram_id, plan } = req.body || {};
  if (!telegram_id || !['free', 'pro'].includes(plan)) {
    return res.status(400).json({ error: 'bad_request' });
  }
  await setPlan(String(telegram_id), plan);
  res.json({ ok: true, telegram_id: String(telegram_id), plan });
});

// Malformed JSON, oversized body etc.
app.use((err, req, res, next) => {
  console.warn('[http]', err.message);
  res.status(err.status || 400).json({ error: 'bad_request' });
});

const PORT = Number(process.env.PORT || 3000);
init()
  .then(() => {
    if (!BOT_TOKEN) console.warn('[auth] BOT_TOKEN not set: initData is NOT verified (dev mode)');
    if (ALLOW_UNVERIFIED) console.warn('[auth] ALLOW_UNVERIFIED=1: signature checks can be bypassed, disable it in production');
    if (!process.env.TG_WEBHOOK_SECRET) console.warn('[tg] TG_WEBHOOK_SECRET not set: webhook accepts requests from anyone');
    app.listen(PORT, '0.0.0.0', () => console.log(`[gymai] listening on ${PORT}`));
  })
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });
