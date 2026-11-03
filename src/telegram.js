/* Telegram initData parsing + HMAC verification (WebApp secret key). */
import crypto from 'node:crypto';

/* Parse into raw (as received) and decoded values. */
export function parseInitData(initData) {
  const out = {};
  if (!initData) return out;
  for (const pair of initData.split('&')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = decodeURIComponent(pair.slice(0, idx));
    const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

/* Build the Telegram data_check_string candidates.
   Telegram has changed how the check string is built over time, so we try
   several variants and accept the first one whose HMAC matches. */
function checkStringVariants(initData, hash, signature) {
  const rawPairs = [];
  for (const pair of initData.split('&')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = decodeURIComponent(pair.slice(0, idx));
    const rawV = pair.slice(idx + 1);
    let decV;
    try { decV = decodeURIComponent(rawV.replace(/\+/g, ' ')); } catch (e) { decV = rawV; }
    rawPairs.push({ k, rawV, decV });
  }

  const build = (useRaw, keepSignature) => {
    const items = rawPairs
      .filter((p) => p.k !== 'hash' && p.k !== 'signature')
      .filter((p) => (keepSignature ? true : p.k !== 'signature'));
    const map = new Map();
    for (const p of items) map.set(p.k, useRaw ? p.rawV : p.decV);
    return [...map.keys()].sort().map((k) => `${k}=${map.get(k)}`).join('\n');
  };

  return [
    build(false, false), // decoded values, hash+signature excluded  (canonical)
    build(true, false),  // raw values, hash+signature excluded
    build(false, true),  // decoded values, signature kept
    build(true, true),   // raw values, signature kept
  ];
}

export function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const data = parseInitData(initData);
    const hash = data.hash;
    if (!hash) return null;

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const want = String(hash).toLowerCase();

    let computed = null;
    for (const dcs of checkStringVariants(initData, hash, data.signature)) {
      const h = crypto.createHmac('sha256', secretKey).update(dcs).digest('hex');
      if (h.toLowerCase() === want) { computed = h; break; }
    }
    if (!computed) return null;

    const user = data.user ? JSON.parse(data.user) : {};
    return {
      id: String(user.id || data.user_id || ''),
      username: user.username || '',
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      lang: data.language_code || '',
    };
  } catch (e) {
    return null;
  }
}

/* Extract the user payload from initData WITHOUT checking the signature.
   Only used when the server explicitly enables ALLOW_UNVERIFIED=1
   (e.g. initData issued before a bot-token rotation). */
export function userFromInitDataUnverified(initData) {
  const raw = parseInitData(initData);
  if (!raw || !raw.user) return null;
  try {
    const u = JSON.parse(raw.user);
    if (!u || !u.id) return null;
    return {
      id: String(u.id),
      username: u.username || '',
      first_name: u.first_name || '',
      last_name: u.last_name || '',
      lang: raw.language_code || '',
    };
  } catch (e) {
    return null;
  }
}
