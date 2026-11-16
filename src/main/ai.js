// Direct calls to Groq (Whisper speech-to-text) and Google Gemini (answers,
// chat, summaries) using the user's OWN API keys.
//
// Runs in the Electron main process only. The keys come from keyStore.js and
// never cross into the renderer: the renderer just sends transcript text /
// audio / screenshots over IPC and gets plain text (or a friendly error) back;
// suggestions and chat answers also stream back chunk by chunk (main.js
// forwards each chunk as an 'ai:chunk' event).
//
// Logging rule for this file: never log keys, request bodies, transcripts,
// or full provider error bodies. Only the provider name, HTTP status and the
// provider's short error status (e.g. RESOURCE_EXHAUSTED) are ever logged.

const keyStore = require('./keyStore');
const deepgramCore = require('./deepgram-core');
const { humanizeAnswer, createStreamHumanizer } = require('./humanize');

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

const STT_TIMEOUT_MS = 20_000; // a chunk (at most ~12 s of speech) transcribes well within this
const AI_TIMEOUT_MS = 45_000; // suggestions + chat answers
const HEADLINE_TIMEOUT_MS = 12_000; // instant first line: useless once the full answer is out
const SUMMARY_TIMEOUT_MS = 75_000; // a summary covers the whole transcript
const KEY_TEST_TIMEOUT_MS = 15_000;

// Output budgets (per mode) and thinking levels: see ANSWER_TOKENS and
// resolveThinkingLevel() in the Gemini section below.

function groqModel() {
  return (process.env.GROQ_STT_MODEL || '').trim() || DEFAULT_GROQ_STT_MODEL;
}

function geminiModel() {
  return (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;
}

// Model names go into a URL path -- keep them to the characters real model
// ids use, so a typo in .env can't turn into a different URL.
function safeModelName(model) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) {
    throw aiError('CONFIG', `The model name "${String(model).slice(0, 60)}" in your .env doesn't look valid.`);
  }
  return model;
}

// ---- Errors ----
// Every error thrown from here has a stable `code` (the renderer reacts to
// it) and a message that is safe to show the user verbatim.
function aiError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function providerLabel(provider) {
  if (provider === 'groq') return 'Groq';
  if (provider === 'deepgram') return 'Deepgram';
  return 'Gemini';
}

function missingKeyError(provider) {
  return aiError(
    'NO_KEY',
    `No ${providerLabel(provider)} API key yet -- add one under ⋯ menu > API keys.`
  );
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function networkError(provider, err, callerSignal) {
  if (callerSignal && callerSignal.aborted) {
    return aiError('ABORTED', 'Superseded by a newer request.');
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return aiError('TIMEOUT', `${providerLabel(provider)} took too long to respond -- try again.`);
  }
  // fetch() throws a TypeError for DNS/connection/TLS failures.
  return aiError(
    'OFFLINE',
    `Couldn't reach ${providerLabel(provider)} -- check your internet connection.`
  );
}

// Reads just enough of a provider error body to classify it. The body is
// never logged or shown in full.
async function readProviderError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    // ignore -- classification falls back to the HTTP status
  }
  let status = '';
  let message = '';
  try {
    const parsed = JSON.parse(text);
    const e = parsed && parsed.error;
    if (e && typeof e === 'object') {
      status = typeof e.status === 'string' ? e.status : typeof e.code === 'string' ? e.code : '';
      message = typeof e.message === 'string' ? e.message : '';
    }
  } catch (err) {
    // Non-JSON body (proxy page, etc.)
  }
  return { status, message, raw: text.slice(0, 2000) };
}

function looksLikeBadKey(info) {
  return /API_KEY_INVALID|API key not valid|invalid api key|invalid_api_key|API key expired/i.test(
    `${info.status} ${info.message} ${info.raw}`
  );
}

// Maps an HTTP error from Groq/Gemini to a friendly, safe message.
function httpError(provider, res, info) {
  const label = providerLabel(provider);
  const s = res.status;
  console.error(`[ai] ${label} request failed: HTTP ${s}${info.status ? ` ${info.status}` : ''}`);

  if (s === 401 || s === 403 || ((s === 400 || s === 404) && looksLikeBadKey(info))) {
    return aiError(
      'BAD_KEY',
      `${label} rejected your API key (it may be wrong, revoked, or missing permissions) -- update it under ⋯ menu > API keys.`,
      s
    );
  }
  if (s === 402) {
    return aiError(
      'NO_CREDIT',
      provider === 'deepgram'
        ? 'Your Deepgram account is out of credit -- add credit at console.deepgram.com, or switch Speech-to-text back to Groq in Settings.'
        : `${label} says this account needs billing or credit (HTTP 402).`,
      s
    );
  }
  if (s === 429) {
    return aiError(
      'RATE_LIMIT',
      `${label} rate limit hit -- on the free tier this usually means "wait a minute and try again".`,
      s
    );
  }
  if (s === 404 && provider !== 'deepgram') {
    const model = provider === 'groq' ? groqModel() : geminiModel();
    const envVar = provider === 'groq' ? 'GROQ_STT_MODEL' : 'GEMINI_MODEL';
    return aiError(
      'MODEL_NOT_FOUND',
      provider === 'groq'
        ? `${label} doesn't know the model "${model}" (or your key can't use it) -- check ${envVar} in your .env.`
        : `${label} doesn't know the model "${model}" (or your key can't use it). Google retires older Flash models -- set ${envVar} in your .env to a current Gemini Flash model (see the model list in Google AI Studio), then restart Echo.`,
      s
    );
  }
  if (s === 400 || s === 413) {
    // A plain request problem (e.g. an image Gemini couldn't read). The
    // provider's own short message is useful here and never contains the key.
    const detail = info.message ? `: ${info.message.slice(0, 200)}` : '';
    return aiError('BAD_REQUEST', `${label} couldn't process that request${detail}`, s);
  }
  if (s >= 500) {
    return aiError('PROVIDER_DOWN', `${label} is having problems right now -- try again in a moment.`, s);
  }
  return aiError('PROVIDER_ERROR', `${label} returned an error (${s}) -- try again in a moment.`, s);
}

// =====================================================================
// Groq: speech-to-text
// =====================================================================

// Whisper-family models are trained on captioned video, so when fed a
// near-silent or noise-only chunk they confidently invent plausible text
// ("thanks for watching", stock closers). Groq's verbose_json response gives
// per-segment no_speech_prob / avg_logprob -- exactly what Groq's own docs
// recommend using to catch this. A known-phrase list is a second, cheap layer.
const NO_SPEECH_PROB_THRESHOLD = 0.6;
const AVG_LOGPROB_THRESHOLD = -1.0;
const KNOWN_HALLUCINATION_PHRASES = new Set([
  'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
  'please subscribe', 'subscribe', 'bye bye', 'thank you for watching',
  "i'll see you next time", 'see you next time', 'thanks for listening',
]);

function looksLikeHallucinatedSilence(text, segments) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  if (KNOWN_HALLUCINATION_PHRASES.has(normalized)) return true;
  if (Array.isArray(segments) && segments.length) {
    const allLowConfidence = segments.every((s) => {
      const noSpeech = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0;
      const avgLogprob = typeof s.avg_logprob === 'number' ? s.avg_logprob : 0;
      return noSpeech > NO_SPEECH_PROB_THRESHOLD || avgLogprob < AVG_LOGPROB_THRESHOLD;
    });
    if (allLowConfidence) return true;
  }
  return false;
}

async function transcribeAudio({ base64, mimeType }) {
  const apiKey = keyStore.getKey('groq');
  if (!apiKey) throw missingKeyError('groq');
  if (!base64) return '';

  const buffer = Buffer.from(base64, 'base64');
  // Skip near-silent/empty chunks (saves a call -- and free-tier quota -- every cycle).
  if (buffer.length < 2000) return '';

  const cleanMime = typeof mimeType === 'string' && /^audio\/[\w.+-]+(;.*)?$/.test(mimeType) ? mimeType : 'audio/webm';
  const ext = cleanMime.includes('webm') ? 'webm' : cleanMime.includes('ogg') ? 'ogg' : 'wav';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: cleanMime }), `chunk.${ext}`);
  form.append('model', safeModelName(groqModel()));
  // verbose_json (not plain json) so we get per-segment no_speech_prob /
  // avg_logprob for looksLikeHallucinatedSilence().
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  let res;
  try {
    res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError('groq', err);
  }

  if (!res.ok) throw httpError('groq', res, await readProviderError(res));

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw aiError('PROVIDER_ERROR', 'Groq sent back a response Echo could not read -- try again.');
  }
  const text = (data && typeof data.text === 'string' ? data.text : '').trim();
  if (looksLikeHallucinatedSilence(text, data && data.segments)) return '';
  return text;
}

// =====================================================================
// Gemini: suggestions, chat, summaries
// =====================================================================

// ---- Prompts ----
// Prompts avoid em dashes themselves: models copy the punctuation they see.
const SCREEN_NOTE = `\nOne or more attached screen images may be included (in the order they were captured, oldest first). If they are, use them as context: read any visible code, error messages, slides, questions, or diagrams before answering. A problem can be split across several screenshots, so consider them together. Their names (e.g. window/tab titles) are also given to you in the prompt.`;

// Knowledge files are often AI-written CVs: facts yes, wording never.
const KNOWLEDGE_NOTE = `\nBackground material about the user may be included, pulled from their own CV/notes/project files. Use it ONLY as a source of facts: which projects, employers, tools, numbers and results are real. Never copy its wording or phrasing. CVs and notes are often written in stiff, polished, AI-style language ("spearheaded", "leveraged", "passionate about", "drove cross-functional synergy"), and the user has to sound like themselves talking. Re-say every fact in plain spoken words, the way they'd tell a friend. Prefer these real facts over generic knowledge, and never invent details, projects, or experience beyond what's given there or stated in the transcript.`;

// What every suggest/ask request carries -- see buildConversation().
const CONTEXT_NOTE = `\nWhat you are given: the WHOLE conversation so far ("You" = the user, "Them" = the other side, oldest first; it is auto-transcribed, so expect small errors), the answers already suggested earlier in this session, any background and screenshots, and -- at the very end, under "LATEST" -- the last few lines and the question to answer now. Answer the latest question. Use the earlier conversation for continuity: "expand on that" or "going back to earlier" refer to what was said or answered before. Don't repeat an earlier answer word for word; build on it.`;

// Words and patterns that make an answer sound machine-written when said
// out loud. humanize.js also strips em dashes and stock openers afterwards,
// as a safety net.
const BANNED_TELLS = `Never use these AI tells: "Great question", "Certainly", "Absolutely", "I'd be happy to", "leverage", "delve", "utilize", "passionate about", "spearheaded", "synergy", "robust", "seamless", "cutting-edge", "game-changer", "it's worth noting", "in summary", "in conclusion", "overall", "furthermore", "moreover", "additionally", "I'm excited to", "thrilled", "a testament to", "navigate", "foster", "holistic", "dive into", "key takeaway", "in today's fast-paced world", "Not only X but also Y" constructions, and neat lists of three adjectives ("fast, scalable and reliable"). Never use em dashes (—): use a comma or a full stop, or start a new sentence.`;

// Highest-priority rule: sounding human must never mean making things up.
const GROUNDING = `\nTRUTH FIRST (this overrides every style rule below): only state facts about the user (projects, jobs, schools, tools, numbers, results, stories) that appear in the transcript or in their background material. If a fact isn't there, don't guess: keep it general or use a short [placeholder] they can fill in. The tone examples below use made-up facts purely to show style; never reuse any of their details. For technical facts (APIs, complexities, definitions), say only what you're confident is correct; if unsure, say so in a few words rather than guessing.`;

const HUMAN_VOICE = `\nSound like a real person talking, not like an AI or a cover letter:
- Use contractions (I'm, I've, it's, didn't, that's) and plain everyday words: "use", not "utilize"; "helped build", not "spearheaded".
- Keep sentences short and vary their length. A four-word sentence is fine. Talk in the first person ("I", or "we" for a team).
- Concrete beats polished: name the actual project, tool, number or result instead of a general claim, but ONLY ones that appear in the transcript or the user's background material. If there's no such fact, stay general or use a [placeholder]; never make one up.
- Now and then (not in every answer) it's fine to open the way people really do: "So,", "Yeah, so", "Honestly,". Most answers should just start with the point.
- Talk like a smart friend explaining something across a table, not like someone presenting slides. Answer what was actually asked; never repeat the question back.
- Don't make it too tidy. Real answers aren't perfectly symmetrical: don't always give exactly three points, don't make every sentence the same shape, and don't wrap up with a neat moral ("That taught me the value of teamwork"). End on a concrete detail, or just stop.
- People mention the messy part (what was hard, what went wrong first, what they'd do differently), but only when that detail is in the user's facts. Never invent a struggle, a failure or a lesson to sound real.
- Say numbers the way people say them out loud: "about a third", "around 200 users", "a couple of weeks", not "33.7%" or "a 2-week period".
- Light, natural hedging is fine where a person would use it ("I think", "probably", "if I remember right"), but stay confident about the user's own facts and never hedge every sentence.
- Match how the user actually talks: look at their own "You" lines in the transcript and mirror their vocabulary and how formal or casual they are. Match the other person's tone too (casual chat vs a formal panel).
- ${BANNED_TELLS}

Examples of the difference. They show TONE only: never reuse their facts.
BEFORE (stiff AI): "Great question! I'm passionate about building robust, scalable, and seamless systems, and I spearheaded a migration that leveraged microservices."
AFTER (spoken): "So, the one I'm proudest of is moving our payments code off the old monolith.
I split it into three services over about two months.
Deploys went from once a week to most days, and the Friday pages stopped."

BEFORE (stiff AI): "Certainly. In my previous role, I utilized Python to streamline data workflows — resulting in significant efficiency gains."
AFTER (spoken): "At my last job I wrote the Python scripts that cleaned our sales data every night.
It used to take someone half a day by hand.
After that it just ran on its own."

BEFORE (stiff AI): "Overall, my greatest weakness is that I care deeply about delivering high-quality work."
AFTER (spoken): "Honestly, I used to say yes to too much.
Last term I had three projects going at once and one of them slipped.
Now I check my week before I take anything new on."`;

// Answer style (Settings > Answer style; renderer sends answerStyle).
// SCRIPT: full sentences to read out. CUES: a first line to say, then
// keyword prompts the user talks around in their own words.
const ANSWER_STYLES = new Set(['script', 'cues']);

const SCRIPT_STYLE = `\nAnswer style: SCRIPT. The user will say this out loud, glancing at it mid-conversation:
- Start with ONE short headline sentence that directly answers the question, in the user's own voice, on its own line, followed by a blank line. It should work on its own if that's all they manage to say.
- Then 1-3 more short spoken sentences, ONE sentence per line (a line break after every sentence). Nothing the user would stumble over saying. No menu of options.
- When relevant, include a concrete result or outcome (a number, what changed, what it led to). For behavioural "tell me about a time" questions use a compressed STAR shape: the situation in a clause, what I did, and end on the result.
- Minimal formatting: plain sentences. No headings, no bullet lists, no tables, no LaTeX. You may **bold** one or two key words (never whole sentences).
- Never invent projects, employers, numbers or experience that aren't in the transcript or the user's background material. If a detail is missing, keep it general.`;

const CUES_STYLE = `\nAnswer style: CUES. The user wants prompts to talk around in their own words, not a script to read:
- Line 1: ONE short headline sentence they can say straight away, directly answering the question, in their own voice. Then a blank line.
- Then 3-4 cue lines. Each starts with "- " and a **bold keyword or short phrase** (2-4 words), optionally followed by a few plain words of detail (a number, a name, a result). Fragments only: no full sentences, no explanations, no filler.
- Put the cues in the order the user should talk through them. For behavioural "tell me about a time" questions follow STAR (situation, what I did, result) and make the last cue the concrete result.
- No headings, no tables, no LaTeX, and nothing after the cues.
- Never invent projects, employers, numbers or experience that aren't in the transcript or the user's background material. If a detail is missing, keep the cue general.
Example of the format (facts made up, never reuse them):
"I'd start with the payments migration I did last summer.

- **Old monolith** slow weekly deploys
- **Split into 3 services** over two months
- **Result** deploys most days, no more Friday pages"`;

const TECHNICAL_STYLE = `\nCoding, maths, probability, puzzles and system design (in either answer style). There are two kinds of technical question, and they get different formats. These rules override the format rules above for these questions only.
A) A NEW problem to solve (a coding task, a maths/probability question, a puzzle, "design a system"). Interviewers want to hear HOW the user thinks, not just the final answer, so show the thought process the user can say out loud while working:
1. Line 1: a one-line spoken summary of the approach (what the user would say first), then a blank line.
2. A short "thinking out loud" walk-through as a numbered list (3-5 items, each one short spoken line in the user's voice, no long explanations). For code, roughly: what the input/output is and any edge case worth checking; the simple brute-force idea and why it's too slow (with its complexity); the key insight that makes it better; the plan for the final approach. For maths/probability: what's being asked, the setup, then the key steps. For system design: the requirements to confirm, the core components, the main trade-off.
3. Then what's needed to actually solve it: for code, ONE complete, correct code block in the language (and method signature) shown on screen if there is one, nothing left out; for maths/probability, the final answer with the number; for design, the final design in a few short lines.
4. End with one line on time/space complexity where it applies, and optionally one line on how to quickly test it with a small example.
B) A FOLLOW-UP about a solution or code already discussed ("why did you use X", "what if the input is empty", "what's the complexity", "how would you test it", "any edge cases", "can you explain this part"), or a quick conceptual question. Answer it like a person in the room would: the headline sentence with the direct answer, then 1-3 short spoken lines with the reasoning. No numbered walk-through, and don't repeat the full code. Only if the answer changes the code, add one tiny code block with just the changed lines. Use the earlier answers in this session to know what the code is.
Keep every line plain and spoken (same voice rules as above). In CUES style, keep the numbered steps as short fragments rather than sentences.`;

function normalizeAnswerStyle(style) {
  return typeof style === 'string' && ANSWER_STYLES.has(style) ? style : 'script';
}

function commonNotes(answerStyle) {
  const style = normalizeAnswerStyle(answerStyle) === 'cues' ? CUES_STYLE : SCRIPT_STYLE;
  return `${GROUNDING}${HUMAN_VOICE}${style}${TECHNICAL_STYLE}${CONTEXT_NOTE}${SCREEN_NOTE}${KNOWLEDGE_NOTE}`;
}

const MODE_INTROS = {
  interview: `You are a live interview co-pilot. The user is in a real interview right now and will answer in their own voice, using what you write. Ground answers in the user's real background if it appears in the transcript or context.`,
  meeting: `You are a live meeting co-pilot. Suggest what the user could say right now: the headline is their contribution in one sentence (an answer, a position, or a useful question), with a little support after it. Only go longer if the moment clearly calls for it (e.g. drafting text, or working through a problem shown on screen), and then give the complete thing.`,
  presentation: `You are a live presentation co-pilot helping the user answer audience questions or stay on track. Give a short, confident talking-point answer to the most recent question.`,
  general: `You are a live conversation co-pilot. Suggest a short, useful response to whatever was just said or asked. If the request clearly calls for something longer (e.g. code, a full draft), give the complete thing rather than a truncated version.`,
};

const ASK_SYSTEM_PROMPT = `You are a live conversation co-pilot's chat panel. The user is asking you a quick question about their current live conversation. Answer directly and completely using the transcript, the user's own background material, and any attached screenshots (whichever are present) for context. If the answer calls for code or a full explanation, give the complete version rather than a truncated one. You get the whole conversation so far (oldest first), the answers already given in this session, and the user's question at the end under "LATEST". Use the earlier context for follow-ups ("what did they mean earlier?", "expand on your last answer").
Write the way a sharp friend would reply: plain words, contractions, short sentences, straight to the point, no preamble. If you suggest something for the user to say, write it the way they'd actually say it out loud, in the first person.
${BANNED_TELLS}
If background files from the user (CV/notes) are included, use them only for facts and never copy their wording.`;

const SUMMARY_SYSTEM_PROMPT = `You are summarizing a transcript of a live conversation (a meeting, interview, or call) between "You" (the user) and "Them" (whoever else was on the call: could be one person or several, all merged into "Them" since the app can't tell voices on that side apart). The transcript is auto-transcribed and may contain errors, filler words, or gaps. Do your best with what's there and don't invent content that isn't supported by it. Only report decisions, action items, and unresolved questions that are actually grounded in the transcript. If a category is empty, return an empty array for it rather than making something up.`;

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
      description: 'A concise prose summary of what was discussed, 2-5 sentences.',
    },
    decisions: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Concrete decisions that were made. Empty array if none.',
    },
    actionItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          owner: {
            type: 'STRING',
            description: 'Who owns this — "You", "Them", a name if one was mentioned, or "Unclear".',
          },
          task: { type: 'STRING' },
        },
        required: ['owner', 'task'],
      },
      description: 'Concrete action items / follow-ups. Empty array if none.',
    },
    unresolved: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Questions or open threads that were raised but not resolved. Empty array if none.',
    },
  },
  required: ['summary', 'decisions', 'actionItems', 'unresolved'],
};

function buildSystemPrompt(mode, answerStyle) {
  // hasOwn: don't let e.g. "__proto__" resolve to an inherited property.
  const intro = Object.prototype.hasOwnProperty.call(MODE_INTROS, mode) ? MODE_INTROS[mode] : MODE_INTROS.general;
  return `${intro}${commonNotes(answerStyle)}`;
}

// ---- Conversation context (whole session, not a recent window) ----
// Suggest/ask prompts carry the WHOLE transcript plus earlier answers so
// follow-ups work. The only cap is a safety net far above a normal session
// (~100k chars is several hours of talk); past it the OLDEST lines go first.
// (main.js validates the IPC payload at a higher limit, because summaries
// get the untrimmed transcript.)
const MAX_PROMPT_TRANSCRIPT_CHARS = 100_000;
const TRANSCRIPT_TRIMMED_MARKER = '[earlier conversation trimmed]';
const MAX_PREVIOUS_ANSWERS = 10;
const PREVIOUS_ANSWER_CHARS = 1200;
const PREVIOUS_QUESTION_CHARS = 300;
const LATEST_LINES = 6;
const LATEST_CHARS = 2000;

function clip(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Keeps the newest lines that fit in maxChars (marker line included).
function capTranscript(transcript, maxChars = MAX_PROMPT_TRANSCRIPT_CHARS) {
  const text = String(transcript || '').replace(/\r\n/g, '\n').trim();
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - TRANSCRIPT_TRIMMED_MARKER.length - 1);
  const lines = text.split('\n');
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (kept.length ? 1 : 0);
    if (used + cost > budget) {
      // A single giant newest line: keep its tail rather than nothing.
      if (!kept.length) kept.push(lines[i].slice(-budget));
      break;
    }
    kept.push(lines[i]);
    used += cost;
  }
  return `${TRANSCRIPT_TRIMMED_MARKER}\n${kept.reverse().join('\n')}`;
}

function latestLines(cappedTranscript) {
  const lines = cappedTranscript.split('\n').filter((l) => l.trim() && l !== TRANSCRIPT_TRIMMED_MARKER);
  const tail = lines.slice(-LATEST_LINES).join('\n');
  return tail.length > LATEST_CHARS ? `…${tail.slice(-LATEST_CHARS)}` : tail;
}

// The last thing "Them" said (falls back to the last line) -- used for the
// thinking-level heuristic when the renderer didn't name a question.
function latestUtterance(transcript) {
  const lines = String(transcript || '').trim().split('\n').filter((l) => l.trim());
  if (!lines.length) return '';
  const them = lines.filter((l) => /^Them:/.test(l));
  const line = them.length ? them[them.length - 1] : lines[lines.length - 1];
  const colon = line.indexOf(':');
  return (colon !== -1 ? line.slice(colon + 1) : line).trim();
}

function buildPreviousAnswersBlock(previousAnswers) {
  if (!Array.isArray(previousAnswers) || !previousAnswers.length) return '';
  const items = previousAnswers.slice(-MAX_PREVIOUS_ANSWERS).map((a, i) => {
    const label = a.kind === 'chat' ? "Chat answer to the user's own question" : 'Suggested answer';
    const q = a.question ? ` (re: "${clip(a.question, PREVIOUS_QUESTION_CHARS)}")` : '';
    return `[${i + 1}] ${label}${q}:\n${clip(a.text, PREVIOUS_ANSWER_CHARS)}`;
  });
  return `\n\nANSWERS ALREADY GIVEN IN THIS SESSION (oldest first, most recent last):\n\n${items.join('\n\n')}`;
}

const NO_BACKGROUND_NOTE = `\n\nNo background about the user was provided (no CV or notes loaded, or none matched this question). You do NOT know their real projects, employers, schools, numbers or experience. For questions about their own experience, give a natural answer shape with short placeholders in square brackets that they fill in themselves, e.g. "[project name]", "[what you built]", "[result]". Never invent specifics to fill the gap.`;

function buildKnowledgeBlock(knowledgeSnippets) {
  if (!knowledgeSnippets || !knowledgeSnippets.length) return NO_BACKGROUND_NOTE;
  const body = knowledgeSnippets.map((s) => `[from ${s.source}]\n${s.text}`).join('\n\n');
  return `\n\nRelevant background about the user, from their own files:\n\n${body}`;
}

// e.g. "(2 screenshots are attached right below, ..., in capture order: 1. "VS Code", 2. "Chrome".)"
function describeScreenshots(images) {
  if (!images || !images.length) return '';
  if (images.length === 1) {
    const label = images[0].name ? ` ("${images[0].name}")` : '';
    return `\n\n(A screenshot${label} is attached right below, before the LATEST section, for visual context.)`;
  }
  const names = images.map((im, i) => `${i + 1}. ${im.name ? `"${im.name}"` : 'screen'}`).join(', ');
  return `\n\n(${images.length} screenshots are attached right below, before the LATEST section, for visual context, in capture order: ${names}.)`;
}

// Answer-format hint for this one question, placed in LATEST (the system
// prompt stays identical across requests -- see the layout note below).
const KIND_HINTS = {
  problem: 'Question type: a NEW problem to solve. Use the full technical format (spoken summary line, short numbered walk-through, then the complete code or final answer, then complexity).',
  followup: 'Question type: a FOLLOW-UP about the solution or code already discussed (or a quick conceptual question). Keep it short and spoken: the headline sentence with the direct answer, then 1-3 short lines. No numbered walk-through and no full code again; at most one tiny code block with just the changed lines if the answer changes the code.',
};

// Layout, built for Gemini's implicit (prefix) caching and for "the question
// is never buried":
//   [system instruction]                       identical for every request in a mode/style
//   1. FULL CONVERSATION SO FAR                append-only -> the long, stable prefix
//   2. ANSWERS ALREADY GIVEN                   append-only
//   3. background snippets (knowledge files)   re-ranked per question
//   4. screenshots note + the screenshots      (separate image parts)
//   5. "=== LATEST ===" last lines + the question/instruction + format hint
// The transcript is by far the biggest block and only ever grows at its end,
// so consecutive requests share everything up to its old end. Blocks that
// change on (almost) every question -- the knowledge snippets, which are
// searched with the question itself, and the newest answer -- go after it;
// putting them first would make the shared prefix stop at the system prompt.
// Returns { context, latest } text; buildUserParts() puts images between them.
function buildConversation({ transcript, previousAnswers, knowledgeSnippets, question, userQuestion, instruction, images, kind }) {
  const capped = capTranscript(transcript);
  let context = `FULL CONVERSATION SO FAR (chronological, oldest first; "You" = the user, "Them" = the other side):\n\n${capped || '(no transcript yet)'}`;
  context += buildPreviousAnswersBlock(previousAnswers);
  context += buildKnowledgeBlock(knowledgeSnippets);
  context += describeScreenshots(images);
  let latest = '=== LATEST ===';
  const tail = capped ? latestLines(capped) : '';
  if (tail) latest += `\nLast lines of the conversation:\n${tail}`;
  if (userQuestion) latest += `\n\nUser's question to you: ${userQuestion}`;
  else if (question) latest += `\n\nQuestion to answer now (asked by Them): "${question}"`;
  else latest += '\n\nAnswer whatever was most recently asked or said above.';
  if (instruction) latest += `\n\nAdditional instruction from the user: ${instruction}`;
  if (kind && KIND_HINTS[kind]) latest += `\n\n${KIND_HINTS[kind]}`;
  return { context, latest };
}

// The whole prompt as one string (tests, and anything that wants plain text).
function buildConversationText(opts) {
  const { context, latest } = buildConversation(opts);
  return `${context}\n\n${latest}`;
}

// Context text, then each screenshot as its own inline_data part (in
// capture order), then the LATEST text last.
function buildUserParts(conversation, images) {
  const conv = typeof conversation === 'string' ? { context: conversation, latest: '' } : conversation;
  const parts = [{ text: conv.context }];
  for (const image of images || []) {
    if (!image || !image.base64) continue;
    parts.push({
      inline_data: {
        mime_type: image.mimeType || 'image/png',
        data: image.base64,
      },
    });
  }
  if (conv.latest) parts.push({ text: conv.latest });
  return parts;
}

// ---- Thinking level + output budget ----
// Gemini 3 takes generationConfig.thinkingConfig.thinkingLevel
// (minimal | low | medium | high). Never also send thinkingBudget: the API
// 400s on both together. Older (2.x) models use a different knob, so for
// those nothing is sent and the model keeps its default.
//
// Auto policy (Settings > Quality vs speed = Auto) -- speed first:
//   interview -> high ONLY for a NEW problem to solve (classifyQuestion():
//                "write a function", "given an array...", "design a URL
//                shortener", a probability/maths/puzzle question, a long
//                technical problem statement, or screenshots attached that
//                aren't just context for a short follow-up);
//                low for everything else: behavioural questions AND
//                technical follow-ups about code already discussed ("why
//                did you use a hash map?", "what's the complexity?", "what
//                if the input is empty?") -- those get the whole transcript
//                plus the earlier answers (which hold the code) as context,
//                and a short spoken format, so low is enough and ~2x faster.
//   meeting / presentation / general -> low
// Fast = always low, Max = always high.
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);
const QUALITY_SETTINGS = new Set(['auto', 'fast', 'max']);

// Cheap keyword heuristic; deliberately avoids everyday words that show up
// in behavioural questions ("what sort of", "solve a conflict", "salary
// expectations", "on a scale of 1 to 10").
const TECHNICAL_PATTERNS = [
  /```/,
  /\b(code|coding|program(ming)?|implement\w*|function|algorithms?|data structures?|time complexity|space complexity|big[- ]?o|leetcode|hacker ?rank)\b/i,
  /\b(arrays?|linked ?lists?|binary (search|tree)s?|trees?|graphs?|heaps?|queues?|hash ?(map|table|set)s?|matrix|matrices|recursion|recursive|dynamic programming|memoi[sz]\w*|dfs|bfs|depth[- ]first|breadth[- ]first|two pointers?|sliding window|palindromes?|substrings?|subarrays?|anagrams?|fibonacci|(merge|quick|heap|bubble|insertion|topological) ?sort|sorting algorithms?)\b/i,
  /\b(sql|regex|debug(ging)?|stack ?trace|exceptions?|compil(e|er|ation)|o\(n|o\(log|o\(1\))/i,
  /\b(probabilit(y|ies)|expected value|odds of|dice|die rolls?|coin (flip|toss)\w*|random variables?|variance|standard deviation|bayes(ian)?|combinatorics|permutations?|combinations of|n choose k|choose \d)\b/i,
  /\b(maths?|mathematical|equations?|integrals?|derivatives?|prove that|proof|calculate|estimate how many|how many ways|sum of (the|all)|prime numbers?)\b/i,
  /\b(puzzles?|brain ?teasers?|riddles?|logic problems?)\b/i,
  /\b(system design|design (a|an) (\w+ ){0,2}(system|service|app|api|platform|database|cache|url shortener|rate limiter|parking lot|scheduler|key[- ]value store|news ?feed|chat)|scalab\w+|at scale|load balanc\w*|caching|sharding|database schema|throughput|rate limit(er|ing)|microservices?|distributed systems?)\b/i,
  /\d+\s*[*/^%]\s*\d+|\b\d{1,3}\s+[-+]\s+\d{1,3}\b|\bx\^\d|\bn\^2\b|\blog\s*n\b/i, // arithmetic, not year ranges
];

function looksTechnical(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return TECHNICAL_PATTERNS.some((re) => re.test(t));
}

// ---- New problem vs follow-up (classifyQuestion) ----
// A request to solve / build something, phrased as an ask: at the start of
// a sentence, or after "can you", "please", "let's", "how would you", ...
const ASK_PREFIX = String.raw`(?:^|[.?!:;]\s+|\b(?:can|could|would|will) you\s+(?:please\s+)?|\bplease\s+|\b(?:now|so|okay|ok|alright|next|first|then),?\s+|\blet'?s\s+|\b(?:i'?d like|i want|i need) you to\s+|\bgo ahead and\s+|\btry (?:to\s+)?|\bhow (?:would|could|do|can|should) you\s+)`;
const PROBLEM_VERBS = String.raw`(?:write|implement|code(?: up)?|build|create|design|architect|solve|find|return|count|compute|calculate|determine|check|detect|reverse|merge|sort|rotate|remove|validate|serialize|deserialize|flatten|traverse|invert|print|generate|convert|parse|estimate|prove|simulate|search|partition|schedule|model)`;

// Enough on their own (the question reads like a problem statement even
// when the technical keywords above miss it).
const STRONG_PROBLEM_PATTERNS = [
  /```/,
  /\b(leetcode|hacker ?rank|coding (problem|question|challenge|exercise|task)|(next|following|first|second|another) (problem|exercise|coding question)|here'?s (a|the|your|another) (problem|puzzle|task|challenge|brain ?teaser|exercise)|here is (a|the|your|another) (problem|puzzle|task|challenge|brain ?teaser|exercise)|the (problem|task|challenge) is\b|your task is)\b/i,
  /\b(brain ?teasers?|puzzles?|riddles?|logic problems?)\b/i,
  /\b(probability (of|that)|expected (value|number)|odds (of|that)|in how many ways|how many (ways|different|possible|combinations)|estimate how many|prove that|n choose k)\b/i,
  /\bgiven (a|an|two|three|the|some|n|k|\d+) (\w+ ){0,3}(arrays?|strings?|trees?|graphs?|matri(x|ces)|grids?|integers?|binary|linked lists?|sorted|unsorted|intervals?|nodes?|lists? of (numbers|integers|strings|words|intervals|points|pairs|meetings|prices|stock prices))\b/i,
  /\b(minimum|maximum|fewest|shortest|longest|smallest|largest|kth|k-th) (number of|path|subarray|substring|subsequence|sum|product|distance|element|profit|depth|window)\b/i,
];
// Need a technical question to count (an ask + a solve verb).
const WEAK_PROBLEM_PATTERNS = [
  new RegExp(`${ASK_PREFIX}${PROBLEM_VERBS}\\b`, 'i'),
];

// About work that already exists (the user's code / solution / last answer).
const FOLLOWUP_PATTERNS = [
  /\bwhy (did|do|would|didn'?t|don'?t|wouldn'?t|have|are) you\b/i,
  /\bwhy (not|use|is|are|does|this|that|a|an|the)\b/i,
  /\bwhat (if|happens|would happen|about|changes|would change)\b/i,
  /\bhow about\b/i,
  /\bcomplexit(y|ies)\b|\bbig[- ]?o\b|\bruntime\b/i,
  /\b(can|could|would) you (explain|walk|talk|go|run|take|tell|clarify|elaborate|justify)\b/i,
  /\b(explain|walk me through|talk me through|take me through|go through|run me through)\s+(why|how|what|your|the|this|that|it|line|each)\b/i,
  /\bhow (would|could|do|did|will|can) you (test|verify|debug|validate|check|handle|deal with|optimi[sz]e|improve|scale|extend|change|modify)\b|\btest cases?\b|\bunit tests?\b/i,
  /\b(edge|corner) cases?\b/i,
  /\b(can|could) you (optimi[sz]e|improve|speed|make it|do (it|this|that|better))\b|\bis there a (better|faster|more efficient|simpler|cleaner)\b|\bbetter (solution|approach|way)\b|\bany (way|optimi[sz]ations?)\b/i,
  /\btrade-?offs?\b|\binstead of\b/i,
  /\b(your|this|that|the above|the same) (code|solution|approach|function|implementation|algorithm|answer|loop|line|variable|data structure|recursion|query|design|method|class)\b/i,
  /\byou (used|wrote|chose|picked|did|said|mentioned|called|added|have|use|wrote)\b/i,
  /\b(does|would|will|can) (it|this|that|your \w+)\b.{0,40}\b(work|handle|scale|break|fail|overflow|terminate|still)\b/i,
];
// The question OPENS like a follow-up: then it is one even if it also says
// "find" or "return" ("what if we need to return all pairs?").
const FOLLOWUP_OPENER_RE = /^(?:(?:so|ok(?:ay)?|and|right|cool|great|nice|alright|got it|thanks|sure|interesting|hmm|um|uh|yeah|now)[,.]?\s+)*(?:why|what if|what happens|what would happen|what about|how about|what'?s the (?:time|space|runtime|big)|what is the (?:time|space|runtime|big)|how (?:would|could|do|did|will) you (?:test|handle|deal|verify|debug|optimi[sz]e|improve|scale|extend|change)|(?:can|could) you (?:explain|walk|talk|tell|optimi[sz]e|improve|clarify)|is there|are there|any (?:edge|corner|other|better)|does (?:it|this|that|your)|would (?:it|this|that|your)|will (?:it|this|that|your)|walk me through (?:your|the|this|that|it)|talk me through (?:your|the|this|that|it)|explain (?:your|the|this|that|why|how))\b/i;
// Plain words that, after a technical answer, still point at the code.
const CODE_REFERENCE_RE = /\b(inputs?|outputs?|returns?|pairs?|elements?|values?|null|empty|duplicates?|negative|overflow|memory|loops?|index|indices|(your|the|this|that)( current)? (code|solution|approach|function|implementation|algorithm|method))\b/i;
const FOLLOWUP_MAX_WORDS = 25; // a short question that references earlier work
const LONG_PROBLEM_WORDS = 40; // a long technical prompt reads as a problem statement

function wordCount(text) {
  const m = String(text || '').trim().match(/\S+/g);
  return m ? m.length : 0;
}

// 'problem'  -- a NEW problem to solve (full walk-through, high thinking in interviews)
// 'followup' -- a technical follow-up / conceptual question (short answer, low thinking)
// 'general'  -- everything else (behavioural, small talk, meetings)
// opts.hasImages: screenshots are attached; opts.hasPriorAnswer: answers
// were already given this session; opts.priorCode: a recent answer was a
// technical one (so plain-word follow-ups like "what if the input is empty?"
// are about that code).
function classifyQuestion(text, { hasImages = false, hasPriorAnswer = false, priorCode = false } = {}) {
  const t = String(text || '').trim();
  const technical = looksTechnical(t);
  const words = wordCount(t);
  const strong = STRONG_PROBLEM_PATTERNS.some((re) => re.test(t));
  const problem = strong || (technical && WEAK_PROBLEM_PATTERNS.some((re) => re.test(t)));
  const followup = FOLLOWUP_PATTERNS.some((re) => re.test(t));
  const opener = FOLLOWUP_OPENER_RE.test(t);
  const clearFollowUp = followup && words < FOLLOWUP_MAX_WORDS && (opener || !problem);

  // Screenshots usually show a problem -- unless this is plainly a short
  // follow-up to an answer already given (e.g. "Keep screenshots" is on).
  if (hasImages) return clearFollowUp && hasPriorAnswer && !strong ? 'followup' : 'problem';
  if (!technical && !problem) {
    return followup && priorCode && words < LONG_PROBLEM_WORDS && CODE_REFERENCE_RE.test(t) ? 'followup' : 'general';
  }
  if (clearFollowUp) return 'followup';
  if (problem) return 'problem';
  if (followup) return 'followup'; // long, but about the existing code
  if (words >= LONG_PROBLEM_WORDS) return 'problem';
  return 'followup'; // short technical question with no task in it: conceptual
}

// What classifyQuestion() needs to know about the answers given so far.
function priorContext(previousAnswers) {
  const list = Array.isArray(previousAnswers) ? previousAnswers : [];
  const recent = list.slice(-2);
  return {
    hasPriorAnswer: list.length > 0,
    priorCode: recent.some((a) => /```/.test(a.text || '') || looksTechnical(a.question || '')),
  };
}

function normalizeQuality(quality) {
  return typeof quality === 'string' && QUALITY_SETTINGS.has(quality) ? quality : 'auto';
}

// kind: classifyQuestion() result, if the caller already has it.
function resolveThinkingLevel({ mode, quality, question, hasImages, hasPriorAnswer, kind } = {}) {
  const q = normalizeQuality(quality);
  if (q === 'fast') return 'low';
  if (q === 'max') return 'high';
  if (mode !== 'interview') return 'low';
  const k = kind || classifyQuestion(question, { hasImages, hasPriorAnswer });
  return k === 'problem' ? 'high' : 'low';
}

function supportsThinkingLevel(model) {
  return /^gemini-3/i.test(model);
}

// Visible-answer budgets: tight for spoken answers (shorter = sooner), more
// for code. Gemini 3 counts thinking tokens against maxOutputTokens too, so
// each level gets headroom on top -- otherwise a "high" think could eat the
// whole budget and leave an empty answer. The prompt, not this cap, is what
// keeps normal answers short; the cap is the backstop (it never slows an
// answer down, it only stops a runaway one).
const ANSWER_TOKENS = {
  spoken: 400,
  followUp: 700, // headline + 1-3 lines + maybe a tiny snippet
  detailed: 900, // Shorten / Expand / other explicit instructions
  technical: 2560, // walk-through steps + full code + complexity
  chat: 1024,
  chatTechnical: 3072,
  summary: 4096,
  headline: 80, // the instant first line: one sentence
};
const THINKING_HEADROOM_TOKENS = { minimal: 256, low: 1536, medium: 3072, high: 8192 };
// No thinkingConfig sent (2.x model, or rejected): the model thinks at its default.
const DEFAULT_THINKING_HEADROOM_TOKENS = 4096;

function answerTokensFor(kind, instruction) {
  if (kind === 'problem' || /```/.test(instruction || '')) return ANSWER_TOKENS.technical;
  if (instruction) return Math.max(ANSWER_TOKENS.detailed, kind === 'followup' ? ANSWER_TOKENS.followUp : 0);
  return kind === 'followup' ? ANSWER_TOKENS.followUp : ANSWER_TOKENS.spoken;
}

// ---- Per-session adaptive state ----
// thinkingRejected: the model 400'd on thinkingConfig once -> stop sending it.
// minimalRejected: the model only refused the 'minimal' level (some models
// don't have it) -> use 'low' for those requests instead, and keep thinking
// control for everything else.
// streamFailures: consecutive broken streams -> after a couple, stop trying
// to stream for this run (e.g. a proxy that buffers SSE).
const session = { thinkingRejected: false, minimalRejected: false, streamFailures: 0 };
const STREAM_DISABLE_AFTER_FAILURES = 2;

function resetSessionState() {
  session.thinkingRejected = false;
  session.minimalRejected = false;
  session.streamFailures = 0;
}

function geminiBody(req, withThinking, level = req.thinkingLevel) {
  const headroom = withThinking
    ? THINKING_HEADROOM_TOKENS[level] || DEFAULT_THINKING_HEADROOM_TOKENS
    : DEFAULT_THINKING_HEADROOM_TOKENS;
  return {
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    contents: [{ role: 'user', parts: req.parts }],
    generationConfig: {
      ...(req.generationConfig || {}),
      maxOutputTokens: (req.answerTokens || ANSWER_TOKENS.spoken) + headroom,
      ...(withThinking ? { thinkingConfig: { thinkingLevel: level } } : {}),
    },
  };
}

function looksLikeThinkingRejection(info) {
  return /thinking/i.test(`${info.message} ${info.raw}`);
}

// POSTs to models/<model>:<endpoint>. If the model rejects thinkingConfig
// (HTTP 400 that mentions "thinking"), retries once without it and
// remembers that for the rest of the session.
async function postGemini(endpoint, req) {
  const apiKey = keyStore.getKey('gemini');
  if (!apiKey) throw missingKeyError('gemini');
  const model = safeModelName(geminiModel());
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:${endpoint}`;
  let withThinking =
    !!req.thinkingLevel && THINKING_LEVELS.has(req.thinkingLevel) && supportsThinkingLevel(model) && !session.thinkingRejected;
  let level = req.thinkingLevel === 'minimal' && session.minimalRejected ? 'low' : req.thinkingLevel;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          // Header, not ?key= in the URL, so the key can't end up in any URL log.
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(geminiBody(req, withThinking, level)),
        // Covers the whole response, including reading a stream.
        signal: combineSignals(req.signal, req.timeoutMs),
      });
    } catch (err) {
      throw networkError('gemini', err, req.signal);
    }
    if (res.ok) return res;

    const info = await readProviderError(res);
    if (res.status === 400 && withThinking && attempt === 0 && looksLikeThinkingRejection(info)) {
      if (level === 'minimal') {
        // Only this level is unsupported: don't give up thinking control
        // for the full answers too.
        session.minimalRejected = true;
        level = 'low';
        console.warn('[ai] Gemini rejected thinkingLevel "minimal" for this model -- using "low" for those requests.');
        continue;
      }
      session.thinkingRejected = true;
      withThinking = false;
      console.warn('[ai] Gemini rejected thinkingConfig for this model -- retrying without it for the rest of this session.');
      continue;
    }
    throw httpError('gemini', res, info);
  }
  // Unreachable: the loop either returns or throws.
  throw aiError('PROVIDER_ERROR', 'Gemini returned an error -- try again in a moment.');
}

function readCandidate(data) {
  const candidate = (data && data.candidates && data.candidates[0]) || null;
  if (!candidate) {
    const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
    if (blockReason) {
      throw aiError('BLOCKED', `Gemini declined to answer this one (${String(blockReason).slice(0, 60)}).`);
    }
    return { text: '', finishReason: null };
  }
  const outParts = (candidate.content && candidate.content.parts) || [];
  // Skip "thought" parts if a model ever returns them.
  const text = outParts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  return { text, finishReason: candidate.finishReason || null };
}

// Non-streaming path: summaries, and the fallback when streaming fails.
async function callGeminiOnce(req) {
  const res = await postGemini('generateContent', req);
  let data;
  try {
    data = await res.json();
  } catch (err) {
    if (req.signal && req.signal.aborted) throw aiError('ABORTED', 'Superseded by a newer request.');
    if (err && err.name === 'TimeoutError') throw aiError('TIMEOUT', 'Gemini took too long to respond -- try again.');
    throw aiError('PROVIDER_ERROR', 'Gemini sent back a response Echo could not read -- try again.');
  }
  const { text, finishReason } = readCandidate(data);
  return { text: text.trim(), finishReason };
}

// ---- Server-sent events (streamGenerateContent?alt=sse) ----
// Incremental parser: push() decoded text as it arrives; onData(payload) is
// called with each event's joined "data:" lines. Events end at a blank line
// (\n\n or \r\n\r\n), which may be split across network chunks.
function createSseParser(onData) {
  let buffer = '';
  function flushEvent(raw) {
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return; // comment / keep-alive / other fields
    const payload = dataLines.join('\n');
    if (payload.trim() === '[DONE]') return;
    onData(payload);
  }
  return {
    push(text) {
      buffer += text;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        flushEvent(raw);
      }
    },
    end() {
      if (buffer.trim()) flushEvent(buffer);
      buffer = '';
    },
  };
}

function streamReadError(err, callerSignal) {
  if (callerSignal && callerSignal.aborted) return aiError('ABORTED', 'Superseded by a newer request.');
  if (err && err.name === 'TimeoutError') return aiError('TIMEOUT', 'Gemini took too long to respond -- try again.');
  return aiError('STREAM_FAILED', 'The answer stream was interrupted.');
}

// Streams one answer; onChunk(delta) gets each new piece of visible text.
// Resolves { text, finishReason } once the stream ends.
async function streamGemini(req, onChunk) {
  const res = await postGemini('streamGenerateContent?alt=sse', req);
  if (!res.body || typeof res.body.getReader !== 'function') {
    throw aiError('STREAM_FAILED', 'Gemini did not send a stream.');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let finishReason = null;
  let blockReason = null;
  let sawEvent = false;
  let streamError = null;

  const parser = createSseParser((payload) => {
    if (streamError) return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch (err) {
      streamError = aiError('STREAM_FAILED', 'Gemini sent a stream Echo could not read.');
      return;
    }
    sawEvent = true;
    if (obj && obj.error) {
      // e.g. quota or overload reported mid-stream: the non-streaming
      // fallback turns it into the usual friendly message.
      streamError = aiError('STREAM_FAILED', 'Gemini reported an error mid-answer.');
      return;
    }
    const candidate = obj && obj.candidates && obj.candidates[0];
    if (!candidate) {
      const br = obj && obj.promptFeedback && obj.promptFeedback.blockReason;
      if (br) blockReason = br;
      return;
    }
    const parts = (candidate.content && candidate.content.parts) || [];
    const delta = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (delta) {
      text += delta;
      try {
        onChunk(delta);
      } catch (err) {
        // A UI-side problem must never kill the request.
      }
    }
    if (candidate.finishReason) finishReason = candidate.finishReason;
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (streamError) break;
    }
    if (!streamError) {
      parser.push(decoder.decode());
      parser.end();
    }
  } catch (err) {
    throw streamReadError(err, req.signal);
  }
  if (streamError) {
    reader.cancel().catch(() => {});
    throw streamError;
  }
  if (!text && blockReason) {
    throw aiError('BLOCKED', `Gemini declined to answer this one (${String(blockReason).slice(0, 60)}).`);
  }
  if (!sawEvent) throw aiError('STREAM_FAILED', 'Gemini sent an empty stream.');
  return { text: text.trim(), finishReason };
}

// Errors where retrying the same request without streaming is worth it.
const STREAM_FALLBACK_CODES = new Set(['STREAM_FAILED', 'PROVIDER_ERROR', 'PROVIDER_DOWN']);

// Streams when the caller passed onChunk (and streaming hasn't been switched
// off for this session); otherwise -- or if the stream breaks -- falls back
// to a plain generateContent call. The resolved text is always the full
// answer, so a caller that showed partial chunks just replaces them with it.
// req.streamOnly: never fall back (the instant first line -- a non-streamed
// reply would arrive too late to be worth showing).
async function callGemini(req) {
  const canStream = typeof req.onChunk === 'function' && session.streamFailures < STREAM_DISABLE_AFTER_FAILURES;
  if (req.streamOnly && !canStream) throw aiError('STREAM_FAILED', 'Streaming is off for this session.');
  if (canStream) {
    try {
      const result = await streamGemini(req, req.onChunk);
      // Only full answers vouch for streaming (a tiny headline stream can
      // get through a proxy that breaks long ones).
      if (!req.streamOnly) session.streamFailures = 0;
      return result;
    } catch (err) {
      if ((req.signal && req.signal.aborted) || !STREAM_FALLBACK_CODES.has(err.code) || req.streamOnly) throw err;
      if (err.code === 'STREAM_FAILED') session.streamFailures += 1;
      console.warn(`[ai] Gemini streaming failed (${err.code}) -- falling back to a normal request.`);
    }
  }
  return callGeminiOnce(req);
}

function withCutOffNote({ text, finishReason }) {
  // MAX_TOKENS = Gemini cut the answer short -- flag it rather than silently
  // returning a truncated solution.
  if (finishReason === 'MAX_TOKENS') {
    return `${text}\n\n[cut off: hit the output length limit; click Regenerate, or try a smaller/more specific question]`;
  }
  return text;
}

// Streams through the humanize.js safety net: what the renderer sees while
// streaming is always a prefix of the final (humanized) answer.
function humanizedChunks(onChunk) {
  if (typeof onChunk !== 'function') return undefined;
  const filter = createStreamHumanizer();
  return (delta) => {
    const out = filter.push(delta);
    if (out) onChunk(out);
  };
}

function humanizeResult(result) {
  return { ...result, text: humanizeAnswer(result.text) };
}

async function generateSuggestion({
  transcript, mode, instruction, question, previousAnswers, images, knowledgeSnippets, quality, answerStyle, signal, onChunk,
}) {
  const named = String(question || '').trim();
  const latest = named || latestUtterance(transcript);
  const hasImages = !!(images && images.length);
  const kind = classifyQuestion(latest, { hasImages, ...priorContext(previousAnswers) });
  const thinkingLevel = resolveThinkingLevel({ mode, quality, kind });
  const answerTokens = answerTokensFor(kind, instruction);

  const conversation = buildConversation({ transcript, previousAnswers, knowledgeSnippets, question: named, instruction, images, kind });
  const result = await callGemini({
    systemPrompt: buildSystemPrompt(mode, answerStyle),
    parts: buildUserParts(conversation, images),
    generationConfig: { temperature: 0.4 },
    thinkingLevel,
    answerTokens,
    signal,
    timeoutMs: AI_TIMEOUT_MS,
    onChunk: humanizedChunks(onChunk),
  });
  const groundingFiles = Array.isArray(knowledgeSnippets)
    ? [...new Set(knowledgeSnippets.map((s) => s.source).filter(Boolean))]
    : [];
  return {
    text: withCutOffNote(humanizeResult(result)),
    groundingFiles,
    thinkingLevel,
    questionKind: kind,
    answerStyle: normalizeAnswerStyle(answerStyle),
  };
}

// ---- Instant first line ("headline") ----
// A tiny, fast call fired in parallel with every suggestion (main.js /
// suggest-pipeline.js): minimal thinking, ~80 output tokens, a trimmed
// context, streamed. Its one sentence is shown in the big first-line slot
// until the full answer's own first sentence is ready (renderer.js), so the
// user has something to say within about a second even when the full answer
// thinks hard. The full answer stays the source of truth.
const HEADLINE_TRANSCRIPT_CHARS = 8000;
const HEADLINE_PREVIOUS_ANSWERS = 2;
const HEADLINE_PREVIOUS_ANSWER_CHARS = 1500;

const HEADLINE_SITUATIONS = {
  interview: 'The user is in a live job interview right now.',
  meeting: 'The user is in a live meeting right now.',
  presentation: 'The user is presenting and taking questions right now.',
  general: 'The user is in a live conversation right now.',
};

function buildHeadlineSystemPrompt(mode) {
  const situation = Object.prototype.hasOwnProperty.call(HEADLINE_SITUATIONS, mode) ? HEADLINE_SITUATIONS[mode] : HEADLINE_SITUATIONS.general;
  return `${situation} Give ONLY the first sentence the user should say out loud right now, in their own voice, in reply to the latest question. A fuller answer is being written separately and follows a moment later; your sentence is what they start talking with while it loads.
- Exactly one short spoken sentence (under 25 words), first person, contractions, plain everyday words. It directly answers the question, or opens the answer, and works on its own. It should sound like how a real person naturally starts talking, not a polished opening line.
- No preamble, no quotation marks around it, no labels, no markdown, no lists, no code.
- A NEW coding, maths or design problem: say how you'd start (briefly restate what's asked, or the approach you're sure of). Never state a final number or claim you aren't sure of.
- A follow-up about code already discussed (why X, what if, complexity, testing, edge cases): the direct answer in one line, consistent with the earlier answers.
- Ground it in the conversation and the user's background. Never invent projects, employers, numbers or experience: if the question is about their experience and no matching fact is given, use a short [placeholder] instead.
- ${BANNED_TELLS}`;
}

// Last ~8k chars of the transcript (whole lines), the latest question, the
// last couple of answers (they hold the code a follow-up is about) and the
// knowledge snippets -- enough to say the right first sentence, small enough
// to be quick.
function buildHeadlineConversation({ transcript, previousAnswers, knowledgeSnippets, question, instruction, images, kind }) {
  const recent = capTranscript(transcript, HEADLINE_TRANSCRIPT_CHARS);
  let context = `RECENT CONVERSATION (oldest first; "You" = the user, "Them" = the other side):\n\n${recent || '(no transcript yet)'}`;
  if (Array.isArray(previousAnswers) && previousAnswers.length) {
    const lastFew = previousAnswers.slice(-HEADLINE_PREVIOUS_ANSWERS)
      .map((a) => ({ ...a, text: clip(a.text, HEADLINE_PREVIOUS_ANSWER_CHARS) }));
    context += buildPreviousAnswersBlock(lastFew);
  }
  context += buildKnowledgeBlock(knowledgeSnippets);
  context += describeScreenshots(images);
  let latest = '=== LATEST ===';
  const tail = recent ? latestLines(recent) : '';
  if (tail) latest += `\nLast lines of the conversation:\n${tail}`;
  if (question) latest += `\n\nQuestion to answer now (asked by Them): "${question}"`;
  else latest += '\n\nAnswer whatever was most recently asked or said above.';
  if (instruction) latest += `\n\nAdditional instruction from the user: ${instruction}`;
  if (kind === 'problem') latest += '\n\nThis is a new problem to solve.';
  else if (kind === 'followup') latest += '\n\nThis is a follow-up about what was already discussed.';
  latest += '\n\nReply with ONLY the first sentence the user should say.';
  return { context, latest };
}

// First sentence of the headline reply, without wrapping quotes.
function firstSpokenSentence(text) {
  let t = String(text || '').trim().split('\n').find((l) => l.trim()) || '';
  t = t.trim().replace(/^["'“‘]+/, '');
  const m = /^(.+?[.!?])["'”’]*(?:\s|$)/.exec(t);
  return (m ? m[1] : t).replace(/["'”’]+$/, '').trim();
}

async function generateHeadline({
  transcript, mode, instruction, question, previousAnswers, images, knowledgeSnippets, signal, onChunk,
}) {
  const named = String(question || '').trim();
  const latest = named || latestUtterance(transcript);
  const hasImages = !!(images && images.length);
  const kind = classifyQuestion(latest, { hasImages, ...priorContext(previousAnswers) });
  const filter = typeof onChunk === 'function' ? createStreamHumanizer() : null;
  const result = await callGemini({
    systemPrompt: buildHeadlineSystemPrompt(mode),
    parts: buildUserParts(buildHeadlineConversation({ transcript, previousAnswers, knowledgeSnippets, question: named, instruction, images, kind }), images),
    generationConfig: { temperature: 0.3 },
    thinkingLevel: 'minimal',
    answerTokens: ANSWER_TOKENS.headline,
    signal,
    timeoutMs: HEADLINE_TIMEOUT_MS,
    // A late first line is useless: never fall back to a non-streaming retry.
    streamOnly: true,
    onChunk: filter
      ? (delta) => {
        const out = filter.push(delta);
        if (out) onChunk(out);
      }
      : undefined,
  });
  if (filter) {
    const rest = filter.end(); // e.g. a short reply the opener check was still holding
    if (rest) onChunk(rest);
  }
  return { text: firstSpokenSentence(humanizeAnswer(result.text)), questionKind: kind };
}

async function askFollowUp({
  transcript, question, previousAnswers, images, knowledgeSnippets, mode, quality, signal, onChunk,
}) {
  const hasImages = !!(images && images.length);
  const kind = classifyQuestion(question, { hasImages, ...priorContext(previousAnswers) });
  const thinkingLevel = resolveThinkingLevel({ mode, quality, kind });
  const technical = kind === 'problem' || looksTechnical(question);
  const conversation = buildConversation({ transcript, previousAnswers, knowledgeSnippets, userQuestion: question, images });
  const result = await callGemini({
    systemPrompt: ASK_SYSTEM_PROMPT,
    parts: buildUserParts(conversation, images),
    generationConfig: { temperature: 0.4 },
    thinkingLevel,
    answerTokens: technical ? ANSWER_TOKENS.chatTechnical : ANSWER_TOKENS.chat,
    signal,
    timeoutMs: AI_TIMEOUT_MS,
    onChunk: humanizedChunks(onChunk),
  });
  return withCutOffNote(humanizeResult(result));
}

async function summarizeSession({ transcript }) {
  // Deliberately NOT trimmed -- a summary needs the whole session.
  const userText = `Transcript (chronological, "You" then "Them" lines):\n\n${transcript || '(empty)'}`;
  const result = await callGemini({
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    parts: [{ text: userText }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: SUMMARY_SCHEMA,
    },
    thinkingLevel: 'minimal',
    answerTokens: ANSWER_TOKENS.summary,
    timeoutMs: SUMMARY_TIMEOUT_MS,
  });

  if (result.finishReason === 'MAX_TOKENS') {
    throw aiError('TOO_LONG', 'The transcript was too long to summarize in one go (hit the output length limit). Try a shorter session.');
  }
  try {
    const parsed = JSON.parse(result.text);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.map((a) => ({ owner: String((a && a.owner) || 'Unclear'), task: String((a && a.task) || '') }))
        : [],
      unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved.map(String) : [],
    };
  } catch (err) {
    throw aiError('PROVIDER_ERROR', 'Could not read the summary Gemini returned -- try again.');
  }
}

// =====================================================================
// Key check (Settings > "Test keys"): cheap read-only calls that cost no
// tokens or audio minutes -- list Groq models, fetch the configured Gemini
// model's metadata, list the Deepgram key's projects.
// =====================================================================
function testSuccessMessage(provider) {
  if (provider === 'gemini') return `Works (model ${geminiModel()}).`;
  if (provider === 'deepgram') return `Works (model ${deepgramCore.cleanModel(process.env.DEEPGRAM_MODEL)}).`;
  return `Works (model ${groqModel()}).`;
}

async function testOne(provider) {
  const apiKey = keyStore.getKey(provider);
  if (!apiKey) return { ok: false, set: false, message: 'Not set.' };
  try {
    let res;
    try {
      if (provider === 'deepgram') {
        res = await fetch(deepgramCore.DEEPGRAM_PROJECTS_URL, {
          headers: deepgramCore.authHeaders(apiKey),
          signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
        });
      } else if (provider === 'groq') {
        res = await fetch(GROQ_MODELS_URL, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
        });
      } else {
        const model = safeModelName(geminiModel());
        res = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}`, {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
        });
      }
    } catch (err) {
      throw networkError(provider, err);
    }
    if (!res.ok) throw httpError(provider, res, await readProviderError(res));
    // Drain the body; we only care that the call succeeded.
    await res.text().catch(() => '');
    return { ok: true, set: true, message: testSuccessMessage(provider) };
  } catch (err) {
    return { ok: false, set: true, code: err.code, message: err.message || 'Check failed.' };
  }
}

async function testKeys() {
  const [groq, gemini, deepgram] = await Promise.all([testOne('groq'), testOne('gemini'), testOne('deepgram')]);
  return { groq, gemini, deepgram };
}

module.exports = {
  transcribeAudio,
  generateSuggestion,
  generateHeadline,
  askFollowUp,
  summarizeSession,
  testKeys,
  testOne,
  groqModel,
  geminiModel,
  // Pure helpers, exported for main.js validation and the unit tests.
  QUALITY_SETTINGS,
  ANSWER_STYLES,
  normalizeAnswerStyle,
  buildSystemPrompt,
  MAX_PROMPT_TRANSCRIPT_CHARS,
  TRANSCRIPT_TRIMMED_MARKER,
  capTranscript,
  buildConversation,
  buildConversationText,
  buildUserParts,
  buildHeadlineSystemPrompt,
  firstSpokenSentence,
  looksTechnical,
  classifyQuestion,
  priorContext,
  resolveThinkingLevel,
  answerTokensFor,
  ANSWER_TOKENS,
  THINKING_HEADROOM_TOKENS,
  createSseParser,
  _resetSessionState: resetSessionState,
};
