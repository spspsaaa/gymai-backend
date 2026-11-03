/* Telegram initData parsing + HMAC verification (WebApp secret key). */
import crypto from 'node:crypto';

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

export function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const data = parseInitData(initData);
    const hash = data.hash;
    if (!hash) return null;
    delete data.hash;
    delete data.signature;

    const dataCheckString = Object.keys(data)
      .sort()
      .map((k) => `${k}=${data[k]}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computed !== hash) return null;

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
