// Cloudflare Worker : relais sécurisé entre l'appli et l'IA (Claude ou Gemini).
// Les clés API restent ici (secrets ANTHROPIC_API_KEY et GEMINI_API_KEY), jamais dans le HTML.
//
// Messages audio : Gemini transcrit l'audio (gratuit), puis le fournisseur choisi (Claude ou Gemini)
// répond et corrige le texte retranscrit. Les messages audio demandent donc GEMINI_API_KEY.

const LEVEL_GUIDE = {
  A1: "Beginner (A1): very short, simple sentences, present tense, the most common 500 words.",
  A2: "Elementary (A2): short sentences, simple past and future, everyday vocabulary.",
  B1: "Intermediate (B1): clear sentences, common tenses, some phrasal verbs, familiar topics.",
  B2: "Upper-intermediate (B2): natural, fluent English, varied grammar, idioms explained briefly.",
  C1: "Advanced (C1): rich, nuanced English, precise vocabulary, subtle corrections on style and register."
};

const PROVIDERS = ['claude', 'gemini'];
const PROVIDER_NAMES = { claude: 'Claude', gemini: 'Gemini' };

function systemPrompt(level, opts = {}) {
  let prompt = `You are a friendly, patient English coach for a French-speaking learner.
Learner level: ${LEVEL_GUIDE[level]}

Always answer in EXACTLY this format, with these four tags each on their own line, in this order, and no markdown (no **, no #, no bullet symbols):

[ENGLISH]
Your reply in English, 2 to 4 short sentences, adapted to the learner's level. React to what they said, then end with one question to keep the conversation going.
[PHONETIQUE]
How to pronounce your main sentence, written in a way a French speaker can read (approximate sounds, with the stressed syllables in CAPITALS).
[TRADUCTION]
French translation of your English reply.
[FEEDBACK & CORRECTION]
In French. Look at the learner's last message: if there are mistakes, give the corrected sentence and a one-line explanation of each important mistake. If it was correct, say so briefly and offer one useful tip or a more natural way to say it. If the learner wrote in French, give the English version of what they wanted to say.

Rules: stay on language practice and everyday topics, keep the tone encouraging, never exceed the four sections.`;

  if (opts.transcribed) {
    prompt += `

The learner's last message was SPOKEN and transcribed automatically from their audio. Treat it as their exact words, including grammar mistakes. In [FEEDBACK & CORRECTION], start with "Version corrigée :" followed by the full corrected text of everything they said, then explain the main mistakes. You cannot hear the audio: if a word looks odd or misheard, say it may be a pronunciation issue and how to pronounce it.`;
  }
  if (opts.voice) {
    prompt += `

This is a live spoken conversation, the learner is talking out loud and listening to you. Keep [ENGLISH] to 1 to 3 short, natural spoken sentences and always end with a simple question. Keep [FEEDBACK & CORRECTION] to two short sentences at most.`;
  }
  return prompt;
}

const TRANSCRIBE_PROMPT = `Transcribe this audio exactly as spoken, word for word. The speaker is a French-speaking learner of English, so the audio is mostly English and may contain a few French words. Do NOT correct grammar, vocabulary or pronunciation: write what was really said, even if it is wrong. You may omit pure filler noises such as "uh" or "euh". Add basic punctuation. Output ONLY the transcript, without quotes or comments. If there is no intelligible speech, output exactly: [NO_SPEECH]`;

// ---------- utilitaires ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origins = allowedOrigins(env);
  const origin = request.headers.get('Origin') || '';
  const allow = origins.includes('*') ? '*' : (origins.includes(origin) ? origin : origins[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

// keepTrailingAssistant : pour un message audio, l'historique envoyé finit par une réponse du coach
// et le message de l'apprenant (la transcription) est ajouté ensuite.
function cleanMessages(raw, keepTrailingAssistant = false) {
  if (!Array.isArray(raw)) return [];
  const msgs = raw
    .slice(-20)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 3000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!keepTrailingAssistant) {
    while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
  }
  return msgs;
}

async function safeFetch(url, options, name) {
  try { return await fetch(url, options); }
  catch { throw new HttpError(502, `Impossible de joindre ${name}.`); }
}

// ---------- Claude (Anthropic) ----------
async function callClaude(env, system, messages) {
  const res = await safeFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || env.MODEL || 'claude-haiku-5-5',
      max_tokens: 700,
      system,
      messages
    })
  }, 'Claude');

  if (!res.ok) {
    console.error('Erreur Claude', res.status, await res.text());
    if (res.status === 401 || res.status === 403) throw new HttpError(502, "Clé API Claude refusée. Vérifiez ANTHROPIC_API_KEY.");
    if (res.status === 429) throw new HttpError(429, "Claude est surchargé ou la limite est atteinte. Réessayez dans un instant.");
    throw new HttpError(502, `Claude a renvoyé une erreur (${res.status}).`);
  }

  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// ---------- Gemini (Google AI Studio, palier gratuit) ----------
async function callGemini(env, system, messages) {
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const res = await safeFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { maxOutputTokens: 1000, temperature: 0.7 }
    })
  }, 'Gemini');

  if (!res.ok) {
    console.error('Erreur Gemini', res.status, await res.text());
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new HttpError(502, "Clé Gemini refusée ou modèle indisponible. Vérifiez GEMINI_API_KEY et GEMINI_MODEL.");
    }
    if (res.status === 429) {
      throw new HttpError(429, "Quota gratuit Gemini atteint. Réessayez dans une minute, ou passez sur Claude.");
    }
    throw new HttpError(502, `Gemini a renvoyé une erreur (${res.status}).`);
  }

  const data = await res.json();
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new HttpError(422, "Gemini a refusé ce message. Reformulez-le.");
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
}

// ---------- Transcription d'un message audio (Gemini) ----------
async function transcribeGemini(env, audio) {
  const mime = String(audio.mime || '').toLowerCase().split(';')[0].trim();
  if (!/^audio\/[a-z0-9.+-]{2,30}$/.test(mime)) throw new HttpError(400, "Format audio non reconnu.");
  const b64 = typeof audio.data === 'string' ? audio.data : '';
  if (b64.length < 200) throw new HttpError(400, "Audio vide ou trop court.");
  if (b64.length > 16 * 1024 * 1024) throw new HttpError(413, "Audio trop lourd (environ 10 Mo maximum).");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, "Audio invalide.");

  const model = env.GEMINI_AUDIO_MODEL || env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  // Le JSON est assemblé à la main : éviter JSON.stringify sur un gros audio économise du temps de calcul
  // (utile sur le plan gratuit de Cloudflare). b64 est validé ci-dessus : il ne contient que des caractères sûrs.
  const body =
    '{"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":' + JSON.stringify(mime) +
    ',"data":"' + b64 + '"}},{"text":' + JSON.stringify(TRANSCRIBE_PROMPT) +
    '}]}],"generationConfig":{"temperature":0,"maxOutputTokens":3000}}';

  const res = await safeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body
  }, 'Gemini');

  if (!res.ok) {
    console.error('Erreur transcription Gemini', res.status, (await res.text()).slice(0, 500));
    if (res.status === 400) throw new HttpError(502, "Gemini n'a pas pu lire cet audio (format ou clé). Essayez un enregistrement fait dans l'appli, ou un .mp3 / .wav.");
    if (res.status === 401 || res.status === 403) throw new HttpError(502, "Clé Gemini refusée. Vérifiez GEMINI_API_KEY.");
    if (res.status === 429) throw new HttpError(429, "Quota gratuit Gemini atteint. Réessayez dans une minute.");
    throw new HttpError(502, `Gemini a renvoyé une erreur (${res.status}) pendant la transcription.`);
  }

  const data = await res.json();
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new HttpError(422, "Gemini a refusé cet audio.");
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
  if (!text || text.includes('[NO_SPEECH]')) {
    throw new HttpError(422, "Je n'ai rien entendu dans cet audio. Réessayez en parlant plus près du micro.");
  }
  return text.slice(0, 3000);
}

// ---------- point d'entrée ----------
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405, cors);

    const origins = allowedOrigins(env);
    const origin = request.headers.get('Origin') || '';
    if (!origins.includes('*') && !origins.includes(origin)) {
      return json({ error: 'Origine non autorisée.' }, 403, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Requête invalide.' }, 400, cors); }

    const defaultProvider = PROVIDERS.includes(env.DEFAULT_PROVIDER) ? env.DEFAULT_PROVIDER : 'claude';
    const provider = PROVIDERS.includes(body.provider) ? body.provider : defaultProvider;
    const level = LEVEL_GUIDE[body.level] ? body.level : 'A2';
    const audio = body.audio && typeof body.audio === 'object' ? body.audio : null;
    const messages = cleanMessages(body.messages, !!audio);
    if (!audio && !messages.length) return json({ error: 'Aucun message à traiter.' }, 400, cors);

    const keyName = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
    if (!env[keyName]) {
      return json({ error: `${PROVIDER_NAMES[provider]} n'est pas configuré sur le serveur (secret ${keyName} manquant).` }, 503, cors);
    }
    if (audio && !env.GEMINI_API_KEY) {
      return json({ error: "Les messages audio ont besoin de la clé gratuite GEMINI_API_KEY sur le serveur (la transcription est faite par Gemini)." }, 503, cors);
    }

    try {
      let transcript = null;
      if (audio) {
        transcript = await transcribeGemini(env, audio);
        messages.push({ role: 'user', content: transcript });
      }
      const system = systemPrompt(level, { transcribed: !!audio, voice: body.mode === 'voice' });
      const reply = provider === 'claude'
        ? await callClaude(env, system, messages)
        : await callGemini(env, system, messages);
      if (!reply) throw new HttpError(502, `Réponse vide de ${PROVIDER_NAMES[provider]}.`);
      return json(transcript === null ? { reply, provider } : { reply, provider, transcript }, 200, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      console.error(e);
      return json({ error: 'Erreur inattendue du serveur.' }, 500, cors);
    }
  }
};
