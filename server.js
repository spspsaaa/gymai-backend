import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { init, getUser, saveState, setPlan, bumpCoach, getState, saveSession, getSession } from './src/db.js';
import { verifyInitData } from './src/telegram.js';
import { askCoach } from './src/ai.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const FREE_COACH_LIMIT = Number(process.env.FREE_COACH_LIMIT || 20);

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
  const verified = verifyInitData(initData, BOT_TOKEN);
  if (verified && verified.id) return verified;
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

/* Temporary diagnostics: describe how initData parses (no secrets returned). */
app.post('/api/debug-auth', async (req, res) => {
  const body = req.body || {};
  const initData = body.initData || (req.headers['x-init-data'] || '');
  const { parseInitData } = await import('./src/telegram.js');
  const raw = parseInitData(initData);
  const keys = Object.keys(raw);
  const info = {
    received: true,
    len: String(initData || '').length,
    keys: keys,
    hasHash: !!raw.hash,
    hasSignature: !!raw.signature,
    hasUser: !!raw.user,
    authDate: raw.auth_date || null,
    userPreview: raw.user ? String(raw.user).slice(0, 60) : null,
    botTokenSet: !!BOT_TOKEN,
  };
  const verified = verifyInitData(initData, BOT_TOKEN);
  info.verified = verified ? { id: verified.id, username: verified.username } : null;
  console.warn('[debug-auth]', JSON.stringify(info));
  res.json(info);
});

app.get('/health', async (req, res) => {
  res.json({ ok: true, ai: !!process.env.AI_API_KEY, bot: !!BOT_TOKEN });
});

app.post('/api/auth', async (req, res) => {
  const { initData = '' } = req.body || {};
  let u = verifyInitData(initData, BOT_TOKEN);
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
