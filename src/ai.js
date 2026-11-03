/* AI coach: any OpenAI-compatible chat endpoint. */
const SYSTEM_RU = `Ты — AI-тренер GYM AI. Отвечай кратко, по делу, на языке пользователя.
Давай конкретные рекомендации по тренировкам: упражнения, подходы, повторы, вес, прогрессия.
Не выдумывай данные. Если не хватает информации — задай один уточняющий вопрос.
Формат: короткие абзацы или список. Без markdown-заголовков.`;

const SYSTEM_EN = `You are the GYM AI coach. Be brief and practical.
Give concrete training advice: exercises, sets, reps, weight, progression.
Never invent data. If something is missing, ask one clarifying question.
Use short paragraphs or a list. No markdown headings.`;

// Free-tier models on OpenRouter are frequently rate-limited, so on OpenRouter
// we try the configured model first and then fall back through alternatives.
const MODEL_FALLBACKS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'liquid/lfm-2.5-2.6b:free',
  'openrouter/free',
];

const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);

function cleanReply(text) {
  // Drop <think>...</think> blocks some reasoning models put into content.
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export async function askCoach({ message, lang = 'ru', history = [], state = null, user = null }) {
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error('AI_API_KEY is not set');

  const base = (process.env.AI_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const configured = process.env.AI_MODEL;
  const isOpenRouter = base.includes('openrouter.ai');

  let models;
  if (isOpenRouter) {
    models = configured ? [configured, ...MODEL_FALLBACKS.filter((m) => m !== configured)] : MODEL_FALLBACKS;
  } else if (configured) {
    models = [configured]; // the fallback list is OpenRouter-only
  } else {
    throw new Error('AI_MODEL is not set (required when AI_BASE is not OpenRouter)');
  }

  const msgs = [{ role: 'system', content: lang === 'en' ? SYSTEM_EN : SYSTEM_RU }];

  // Compact context about the athlete, if the app synced any state.
  if (state) {
    const ctx = [];
    const plan = state.gymai_custom_plan;
    const workouts = state.gymai_workouts;
    if (Array.isArray(workouts) && workouts.length) {
      ctx.push(`Recent workouts: ${JSON.stringify(workouts.slice(-5)).slice(0, 3000)}`);
    }
    if (plan) ctx.push(`Current plan: ${JSON.stringify(plan).slice(0, 1200)}`);
    if (ctx.length) msgs.push({ role: 'system', content: 'User context:\n' + ctx.join('\n') });
  }
  if (user && user.first_name) {
    msgs.push({ role: 'system', content: `User name: ${String(user.first_name).slice(0, 60)}` });
  }

  const hist = Array.isArray(history) ? history : [];
  for (const m of hist.slice(-8)) {
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
        body: JSON.stringify({ model: m, messages: msgs, temperature: 0.7, max_tokens: 1400 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      lastError = new Error(`AI network error on ${m}: ${String(e).slice(0, 200)}`);
      continue;
    }

    if (!r.ok) {
      const body = await r.text().catch(() => '');
      lastError = new Error(`AI ${r.status} on ${m}: ${body.slice(0, 300)}`);
      if (RETRYABLE.has(r.status)) {
        console.warn(`[ai] ${m} -> ${r.status}, trying next model`);
        continue;
      }
      throw lastError;
    }

    let j;
    try { j = await r.json(); } catch (e) {
      lastError = new Error(`Bad JSON from ${m}`);
      continue;
    }
    // Only the final answer is used. Never fall back to `reasoning`:
    // it is the model's internal chain of thought, not a reply.
    const reply = cleanReply(j?.choices?.[0]?.message?.content);
    if (!reply) {
      lastError = new Error(`Empty AI reply from ${m}`);
      continue;
    }
    console.log(`[ai] answered by ${m}`);
    return reply;
  }

  throw lastError || new Error('AI: no model available');
}
