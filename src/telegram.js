/* Telegram initData parsing + HMAC verification (WebApp secret key). */
import crypto from 'node:crypto';

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/* Parse into decoded key/value pairs. Never throws. */
export function parseInitData(initData) {
  const out = {};
  if (!initData || typeof initData !== 'string') return out;
  for (const pair of initData.split('&')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    out[safeDecode(pair.slice(0, idx))] = safeDecode(pair.slice(idx + 1).replace(/\+/g, ' '));
  }
  return out;
}

/* Build the Telegram data_check_string candidates.
   Telegram has changed how the check string is built over time, so we try
   several variants and accept the first one whose HMAC matches. */
function checkStringVariants(initData) {
  const rawPairs = [];
  for (const pair of initData.split('&')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = safeDecode(pair.slice(0, idx));
    const rawV = pair.slice(idx + 1);
    rawPairs.push({ k, rawV, decV: safeDecode(rawV.replace(/\+/g, ' ')) });
  }
  const build = (useRaw, keepSignature) => {
    const map = new Map();
    for (const p of rawPairs) {
      if (p.k === 'hash') continue;
      if (p.k === 'signature' && !keepSignature) continue;
      map.set(p.k, useRaw ? p.rawV : p.decV);
    }
    return [...map.keys()].sort().map((k) => `${k}=${map.get(k)}`).join('\n');
  };
  return [
    build(false, false), // decoded values, hash+signature excluded (canonical)
    build(true, false),  // raw values, hash+signature excluded
    build(false, true),  // decoded values, signature kept
    build(true, true),   // raw values, signature kept
  ];
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* maxAgeSec: reject initData older than this (default 30 days; 0 = no check).
   It is only used to obtain a session token, and sessions persist in the DB,
   so a generous window does not log anyone out. */
export function verifyInitData(initData, botToken, maxAgeSec = Number(process.env.INITDATA_MAX_AGE_SEC || 2592000)) {
  if (!initData || !botToken) return null;
  try {
    const data = parseInitData(initData);
    const hash = data.hash;
    if (!hash) return null;

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const want = String(hash).toLowerCase();

    let ok = false;
    for (const dcs of checkStringVariants(initData)) {
      const h = crypto.createHmac('sha256', secretKey).update(dcs).digest('hex');
      if (safeEqualHex(h, want)) { ok = true; break; }
    }
    if (!ok) return null;

    if (maxAgeSec > 0) {
      const authDate = Number(data.auth_date);
      const now = Math.floor(Date.now() / 1000);
      if (!authDate || now - authDate > maxAgeSec || authDate - now > 300) return null;
    }

    const user = data.user ? JSON.parse(data.user) : {};
    return {
      id: String(user.id || data.user_id || ''),
      username: user.username || '',
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      lang: data.language_code || user.language_code || '',
    };
  } catch (e) {
    return null;
  }
}

/* Extract the user payload from initData WITHOUT checking the signature.
   Only used for local dev (no BOT_TOKEN) or when the server explicitly sets
   ALLOW_UNVERIFIED=1 (e.g. initData issued before a bot-token rotation). */
export function userFromInitDataUnverified(initData) {
  try {
    const raw = parseInitData(initData);
    if (!raw.user) return null;
    const u = JSON.parse(raw.user);
    if (!u || !u.id) return null;
    return {
      id: String(u.id),
      username: u.username || '',
      first_name: u.first_name || '',
      last_name: u.last_name || '',
      lang: raw.language_code || u.language_code || '',
    };
  } catch (e) {
    return null;
  }
}
