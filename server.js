import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import {
  init, getUser, upsertUser, saveState, setPlan, getState,
  saveSession, getSession, reserveCoach, refundCoach,
} from './src/db.js';
import { verifyInitData, userFromInitDataUnverified } from './src/telegram.js';
import { askCoach } from './src/ai.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const FREE_COACH_LIMIT = Number(process.env.FREE_COACH_LIMIT || 20);
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED === '1';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://gym-ai-3f0d63ky-3f0d63ky.agent.mira.tg';

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

app.get('/api/state', async (req, res) => {
  try {
    const u = await resolveUser(req);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    const state = await getState(u.id);
    res.json({ state: state || {} });
  } catch (e) {
    console.error('[state:get]', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    const u = await resolveUser(req);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    const { state } = req.body || {};
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return res.status(400).json({ error: 'bad_state' });
    }
    await saveState(u.id, state);
    res.json({ ok: true });
  } catch (e) {
    console.error('[state:put]', e.message);
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
    const state = await getState(u.id);
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
