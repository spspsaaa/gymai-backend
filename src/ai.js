/* AI coach: any OpenAI-compatible chat endpoint. */
const SYSTEM_RU = `Ты — AI-тренер GYM AI. Отвечай кратко, по делу, на языке пользователя.
Давай конкретные рекомендации по тренировкам: упражнения, подходы, повторы, вес, прогрессия.
Не выдумывай данные. Если не хватает информации — задай один уточняющий вопрос.
Формат: короткие абзацы или список. Без markdown-заголовков.`;

const SYSTEM_EN = `You are the GYM AI coach. Be brief and practical.
Give concrete training advice: exercises, sets, reps, weight, progression.
Never invent data. If something is missing, ask one clarifying question.
Use short paragraphs or a list. No markdown headings.`;

export async function askCoach({ message, lang = 'ru', history = [], state = null, user = null }) {
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error('AI_API_KEY is not set');

  const base = (process.env.AI_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'gpt-4o-mini';

  const msgs = [
    { role: 'system', content: lang === 'en' ? SYSTEM_EN : SYSTEM_RU },
  ];

  // Compact context about the athlete, if the app synced any state.
  if (state) {
    const ctx = [];
    const plan = state.gymai_custom_plan;
    const workouts = state.gymai_workouts;
    if (Array.isArray(workouts) && workouts.length) {
      ctx.push(`Recent workouts: ${JSON.stringify(workouts.slice(-5))}`);
    }
    if (plan) ctx.push(`Current plan: ${JSON.stringify(plan).slice(0, 1200)}`);
    if (ctx.length) msgs.push({ role: 'system', content: 'User context:\n' + ctx.join('\n') });
  }
  if (user && user.first_name) {
    msgs.push({ role: 'system', content: `User name: ${user.first_name}` });
  }

  for (const m of (history || []).slice(-8)) {
    if (!m || !m.content) continue;
    msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content).slice(0, 2000) });
  }
  msgs.push({ role: 'user', content: String(message || '').slice(0, 4000) });

  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: msgs,
      temperature: 0.7,
      max_tokens: 1400,
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`AI ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  const msg = j?.choices?.[0]?.message || {};
  let reply = (msg.content || '').trim();
  if (!reply) {
    // Reasoning models may burn max_tokens on reasoning and leave content empty.
    const rsn = (msg.reasoning || '').trim();
    if (rsn) reply = rsn;
  }
  if (!reply) throw new Error('Empty AI reply');
  return reply;
}
