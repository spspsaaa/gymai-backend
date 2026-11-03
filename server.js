import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { init, getUser, saveState, setPlan, bumpCoach, getState, saveSession, getSession } from './src/db.js';
import { verifyInitData, userFromInitDataUnverified } from './src/telegram.js';
import { askCoach } from './src/ai.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const FREE_COACH_LIMIT = Number(process.env.FREE_COACH_LIMIT || 20);


/* Resolve a user from initData.
   Verified HMAC signature first. If it fails and ALLOW_UNVERIFIED=1 is set,
   fall back to the initData payload (needed when initData was issued by a
   different/older bot token and can no longer be signature-verified). */
function resolveInitUser(initData) {
  const v = verifyInitData(initData, BOT_TOKEN);
  if (v && v.id) return { user: v, verified: true };
  if (process.env.ALLOW_UNVERIFIED === '1') {
    const u = userFromInitDataUnverified(initData);
    if (u) {
      console.warn('[auth] initData accepted WITHOUT signature verification (ALLOW_UNVERIFIED=1) id=' + u.id);
      return { user: u, verified: false };
    }
  }
  return { user: null, verified: false };
}

import { upsertUser as _upsertUser } from './src/db.js';


/* ---- Telegram bot: reply with an inline button that opens the mini app ---- */
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://gym-ai-3f0d63ky-3f0d63ky-3f0d63ky.agent.mira.tg';

async function telegramCall(method, payload) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return await r.json().catch(() => null);
  } catch (e) {
    console.warn('[tg]', method, 'failed', String(e).slice(0, 120));
    return null;
  }
}

const APP_BTN = {
  inline_keyboard: [[{ text: '\u0421\u043a\u0430\u0447\u0430\u0442\u044c \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0443', web_app: { url: WEBAPP_URL } }]],
};

async function sendWelcome(chatId) {
  return telegramCall('sendMessage', {
    chat_id: chatId,
    text: '\u041f\u0440\u0438\u0432\u0435\u0442! \u042f \u0438\u0438\u0440\u043e\u0432\u043e\u0439 \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043e\u0447\u043d\u044b\u0439 \u043a\u043e\u0449. \u041e\u0442\u043a\u0440\u043e\u0439 \u043f\u043b\u0430\u043d \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0443, \u0430\u0438 \u0438\u0434\u0435\u0441\u044c \u0441\u043f\u0440\u043e\u0441\u0438 \u0442\u044b \u043f\u0438\u0448\u0438 \u0441\u043a\u0430\u0436\u0435 \u0432 \u043e\u0434\u043d\u043e\u043c \u0447\u0430\u0442\u0435.\n\n\u041d\u0430\u0436\u043c\u0438 \u043a\u043d\u043e\u043f\u043a\u0443 \u2014 \u043f\u0440\u044f\u043c\u043e \u0441\u0442\u0430\u0440\u0442 \u043e\u0431\u0443\u0447\u0435\u043d\u0438\u044f.\n\u0427\u0442\u043e \u0442\u044b \u0445\u043e\u0447\u0435\u0448\u044c \u0441\u0434\u0435\u043b\u0430\u0442\u044c:',
    ...APP_BTN,
    disable_web_page_preview: true,
  });
}

app.post('/api/tg/webhook', async (req, res) => {
  const secret = process.env.TG_WEBHOOK_SECRET || '';
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const up = req.body || {};
    const msg = up.message || up.edited_message;
    if (msg && msg.chat && msg.chat.type !== 'channel') {
      const chatId = msg.chat.id;
      const text = String(msg.text || '').trim();
      if (/^\/start/i.test(text)) {
        const u = await getUser(String(msg.from && msg.from.id));
        if (!u && msg.from) {
          await upsertUserSafe(String(msg.from.id), {
            username: msg.from.username || '',
            first_name: msg.from.first_name || '',
            lang: msg.from.language_code || '',
          });
        }
        await sendWelcome(chatId);
      } else if (text) {
        await telegramCall('sendMessage', {
          chat_id: chatId,
          text: '\u041e\u0442\u043a\u0440\u043e\u0439 \u043a\u043d\u043e\u043f\u043a\u0438 \u2014 \u043e\u0442\u043a\u0440\u043e\u0435 \u043c\u0438\u043d\u0438-\u0430\u043f\u043f, \u043f\u043e\u0434\u0442\u0430\u0439\u0441\u044f \u043f\u0440\u044f\u043c\u043e\u0441\u0442\u044c \u0442\u0440\u0435\u043d\u0438\u0440\u043e\u0432\u043a\u0443.',
          ...APP_BTN,
        });
      }
    }
    return res.json({ ok: true });
  } catch (e) {
    console.warn('[tg] webhook error', String(e).slice(0, 200));
    return res.status(200).json({ ok: true });
  }
});

async function upsertUserSafe(id, patch) {
  try { await _upsertUser(id, patch); } catch (e) {}
}

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
  const initData = body.initData || (req.headers['x-init-data'] || '');
  if (!initData) {
    console.warn('[auth] no initData and no valid token');
    return null;
  }
  const ru = resolveInitUser(initData);
  if (ru.user) return ru.user;
  console.warn('[auth] verifyInitData failed, len=' + String(initData).length);

  // No BOT_TOKEN configured (local dev) - trust initData payload.
  if (!BOT_TOKEN && initData) {
    const { parseInitData } = await import('./src/telegram.js');
    const raw = parseInitData(initData);
    if (raw.user) {
      try {
        const u2 = JSON.parse(raw.user);
        return {
          id: String(u2.id),
          username: u2.username || '',
          first_name: u2.first_name || '',
          last_name: u2.last_name || '',
          lang: raw.language_code || '',
        };
      } catch (e) {}
    }
  }
  return null;
}

app.get('/health', async (req, res) => {
  res.json({ ok: true, ai: !!process.env.AI_API_KEY, bot: !!BOT_TOKEN });
});

app.post('/api/auth', async (req, res) => {
  const { initData = '' } = req.body || {};
  let u = resolveInitUser(initData).user;
  if (!u && !BOT_TOKEN) {
    const { parseInitData } = await import('./src/telegram.js');
    const raw = parseInitData(initData);
    if (raw.user) {
      try {
        const u2 = JSON.parse(raw.user);
        u = {
          id: String(u2.id),
          username: u2.username || '',
          first_name: u2.first_name || '',
          last_name: u2.last_name || '',
          lang: raw.language_code || '',
        };
      } catch (e) {}
    }
  }
  if (!u || !u.id) return res.status(401).json({ error: 'bad_init_data' });

  let rec = await getUser(u.id);
  if (!rec) {
    await (await import('./src/db.js')).upsertUser(u.id, {
      username: u.username, first_name: u.first_name, lang: u.lang, plan: 'free', coach_used: 0, state: null,
    });
    rec = await getUser(u.id);
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
});

app.get('/api/state', async (req, res) => {
  const u = await resolveUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const state = await getState(u.id);
  res.json({ state: state || {} });
});

app.put('/api/state', async (req, res) => {
  const u = await resolveUser(req);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const { state } = req.body || {};
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'bad_state' });
  await saveState(u.id, state);
  res.json({ ok: true });
});

app.post('/api/coach', async (req, res) => {
  const u = await resolveUser(req);
  if (!u) {
    console.warn('[coach] unauthorized: initDataLen=' + String((req.body || {}).initData || '').length + ' hasToken=' + !!tokenFrom(req));
    return res.status(401).json({ error: 'unauthorized' });
  }

  const rec = await getUser(u.id);
  const plan = rec?.plan || 'free';
  const used = Number(rec?.coach_used || 0);
  if (plan !== 'pro' && used >= FREE_COACH_LIMIT) {
    return res.status(402).json({ error: 'limit_reached', used, limit: FREE_COACH_LIMIT });
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
    if (plan !== 'pro') await bumpCoach(u.id);
    res.json({ reply });
  } catch (e) {
    console.error('[coach]', e.message);
    res.status(500).json({ error: 'ai_failed', detail: e.message });
  }
});

/* Admin: grant or revoke Pro. */
app.post('/api/admin/plan', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || '';
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const { telegram_id, plan } = req.body || {};
  if (!telegram_id || !['free', 'pro'].includes(plan)) {
    return res.status(400).json({ error: 'bad_request' });
  }
  await setPlan(String(telegram_id), plan);
  res.json({ ok: true, telegram_id: String(telegram_id), plan });
});

const PORT = Number(process.env.PORT || 3000);
init()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log(`[gymai] listening on ${PORT}`));
  })
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });
