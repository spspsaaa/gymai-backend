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
  // Model candidates. Free-tier models on OpenRouter are frequently
  // rate-limited, so we try the configured model first and then fall back
  // through known-good alternatives instead of failing the whole request.
  const MODEL_FALLBACKS = [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'liquid/lfm-2.5-2.6b:free',
    'nvidia/nemotron-3.5-lightning:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'openrouter/free',
  ];
  const configured = process.env.AI_MODEL;
  const models = configured
    ? [configured, ...MODEL_FALLBACKS.filter((m) => m !== configured)]
    : MODEL_FALLBACKS;
  const model = models[0];

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

  let lastError = null;

  for (const m of models) {
    let r;
    try {
      r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: m,
          messages: msgs,
          temperature: 0.7,
          max_tokens: 1400,
        }),
      });
    } catch (e) {
      lastError = new Error(`AI network error on ${m}: ${String(e).slice(0, 200)}`);
      continue;
    }

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      lastError = new Error(`AI ${r.status} on ${m}: ${body.slice(0, 300)}`);
      // 429 = model rate-limited upstream -> try the next candidate.
      // 404 = model no longer available -> try the next candidate.
      if (r.status === 429 || r.status === 404 || r.status === 503) {
        console.warn(`[ai] ${m} -> ${r.status}, trying next model`);
        continue;
      }
      throw lastError;
    }

    const j = await r.json();
    const msg = j?.choices?.[0]?.message || {};
    let reply = (msg.content || '').trim();
    if (!reply) {
      // Reasoning models may burn max_tokens on reasoning and leave content empty.
      const rsn = (msg.reasoning || '').trim();
      if (rsn) reply = rsn;
    }
    if (!reply) {
      lastError = new Error(`Empty AI reply from ${m}`);
      continue;
    }
    console.log(`[ai] answered by ${m}`);
    return reply;
  }

  throw lastError || new Error('AI: no model available');
}
