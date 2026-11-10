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

// What every suggest/ask request carries -- see buildConversationText().
const CONTEXT_NOTE = `\nWhat you are given: the WHOLE conversation so far ("You" = the user, "Them" = the other side, oldest first; it is auto-transcribed, so expect small errors), the answers already suggested earlier in this session, and -- at the very end, under "LATEST" -- the last few lines and the question to answer now. Answer the latest question. Use the earlier conversation for continuity: "expand on that" or "going back to earlier" refer to what was said or answered before. Don't repeat an earlier answer word for word; build on it.`;

// Words and patterns that make an answer sound machine-written when said
// out loud. humanize.js also strips em dashes and stock openers afterwards,
// as a safety net.
const BANNED_TELLS = `Never use these AI tells: "Great question", "Certainly", "Absolutely", "I'd be happy to", "leverage", "delve", "utilize", "passionate about", "spearheaded", "synergy", "robust", "seamless", "cutting-edge", "game-changer", "it's worth noting", "in summary", "in conclusion", "overall", "Not only X but also Y" constructions, and neat lists of three adjectives ("fast, scalable and reliable"). Never use em dashes (—): use a comma or a full stop, or start a new sentence.`;

const HUMAN_VOICE = `\nSound like a real person talking, not like an AI or a cover letter:
- Use contractions (I'm, I've, it's, didn't, that's) and plain everyday words: "use", not "utilize"; "helped build", not "spearheaded".
- Keep sentences short and vary their length. A four-word sentence is fine. Talk in the first person ("I", or "we" for a team).
- Concrete beats polished: name the actual project, tool, number or result instead of a general claim about yourself.
- Now and then (not in every answer) it's fine to open the way people really do: "So,", "Yeah, so", "Honestly,". Most answers should just start with the point.
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

const TECHNICAL_STYLE = `\nCoding, maths, probability, puzzles and system design (in either answer style). These rules override the format rules above for these questions only. Interviewers want to hear HOW the user thinks, not just the final answer, so show the thought process the user can say out loud while working:
1. Line 1: a one-line spoken summary of the approach (what the user would say first), then a blank line.
2. A short "thinking out loud" walk-through as a numbered list (3-5 items, each one short spoken line in the user's voice, no long explanations). For code, roughly: what the input/output is and any edge case worth checking; the simple brute-force idea and why it's too slow (with its complexity); the key insight that makes it better; the plan for the final approach. For maths/probability: what's being asked, the setup, then the key steps. For system design: the requirements to confirm, the core components, the main trade-off.
3. Then what's needed to actually solve it: for code, ONE complete, correct code block in the language (and method signature) shown on screen if there is one, nothing left out; for maths/probability, the final answer with the number; for design, the final design in a few short lines.
4. End with one line on time/space complexity where it applies, and optionally one line on how to quickly test it with a small example.
Keep every line plain and spoken (same voice rules as above). In CUES style, keep the numbered steps as short fragments rather than sentences.`;

function normalizeAnswerStyle(style) {
  return typeof style === 'string' && ANSWER_STYLES.has(style) ? style : 'script';
}

function commonNotes(answerStyle) {
  const style = normalizeAnswerStyle(answerStyle) === 'cues' ? CUES_STYLE : SCRIPT_STYLE;
  return `${HUMAN_VOICE}${style}${TECHNICAL_STYLE}${CONTEXT_NOTE}${SCREEN_NOTE}${KNOWLEDGE_NOTE}`;
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

function buildKnowledgeBlock(knowledgeSnippets) {
  if (!knowledgeSnippets || !knowledgeSnippets.length) return '';
  const body = knowledgeSnippets.map((s) => `[from ${s.source}]\n${s.text}`).join('\n\n');
  return `\n\nRelevant background about the user, from their own files:\n\n${body}`;
}

// e.g. "(2 screenshots are attached below ..., in capture order: 1. "VS Code", 2. "Chrome".)"
function describeScreenshots(images) {
  if (!images || !images.length) return '';
  if (images.length === 1) {
    const label = images[0].name ? ` ("${images[0].name}")` : '';
    return `\n\n(A screenshot${label} is attached below for visual context.)`;
  }
  const names = images.map((im, i) => `${i + 1}. ${im.name ? `"${im.name}"` : 'screen'}`).join(', ');
  return `\n\n(${images.length} screenshots are attached below for visual context, in capture order: ${names}.)`;
}

// Layout: full transcript -> earlier answers -> background -> screenshots
// note -> "=== LATEST ===" (last lines + the question/instruction) LAST, so
// the thing to answer is never buried above 100k chars of context.
function buildConversationText({ transcript, previousAnswers, knowledgeSnippets, question, userQuestion, instruction, images }) {
  const capped = capTranscript(transcript);
  let text = `FULL CONVERSATION SO FAR (chronological, oldest first; "You" = the user, "Them" = the other side):\n\n${capped || '(no transcript yet)'}`;
  text += buildPreviousAnswersBlock(previousAnswers);
  text += buildKnowledgeBlock(knowledgeSnippets);
  text += describeScreenshots(images);
  text += '\n\n=== LATEST ===';
  const tail = capped ? latestLines(capped) : '';
  if (tail) text += `\nLast lines of the conversation:\n${tail}`;
  if (userQuestion) text += `\n\nUser's question to you: ${userQuestion}`;
  else if (question) text += `\n\nQuestion to answer now (asked by Them): "${question}"`;
  else text += '\n\nAnswer whatever was most recently asked or said above.';
  if (instruction) text += `\n\nAdditional instruction from the user: ${instruction}`;
  return text;
}

// Text first, then each screenshot as its own inline_data part, in order.
function buildUserParts(userText, images) {
  const parts = [{ text: userText }];
  for (const image of images || []) {
    if (!image || !image.base64) continue;
    parts.push({
      inline_data: {
        mime_type: image.mimeType || 'image/png',
        data: image.base64,
      },
    });
  }
  return parts;
}

// ---- Thinking level + output budget ----
// Gemini 3 takes generationConfig.thinkingConfig.thinkingLevel
// (minimal | low | medium | high). Never also send thinkingBudget: the API
// 400s on both together. Older (2.x) models use a different knob, so for
// those nothing is sent and the model keeps its default.
//
// Auto policy (Settings > Quality vs speed = Auto) -- speed first:
//   interview -> low for normal / behavioural questions; high only when the
//                latest question looks like coding / maths / probability /
//                a puzzle / system design, or screenshots are attached
//                (usually a problem on screen)
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
  /\b(system design|design (a|an) \w+ (system|service|app|api|platform|database)|scalab\w+|at scale|load balanc\w*|caching|sharding|database schema|throughput|rate limit(er|ing)|microservices?|distributed systems?)\b/i,
  /\d+\s*[*/^%]\s*\d+|\b\d{1,3}\s+[-+]\s+\d{1,3}\b|\bx\^\d|\bn\^2\b|\blog\s*n\b/i, // arithmetic, not year ranges
];

function looksTechnical(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return TECHNICAL_PATTERNS.some((re) => re.test(t));
}

function normalizeQuality(quality) {
  return typeof quality === 'string' && QUALITY_SETTINGS.has(quality) ? quality : 'auto';
}

function resolveThinkingLevel({ mode, quality, question, hasImages } = {}) {
  const q = normalizeQuality(quality);
  if (q === 'fast') return 'low';
  if (q === 'max') return 'high';
  if (mode === 'interview') return hasImages || looksTechnical(question) ? 'high' : 'low';
  return 'low';
}

function supportsThinkingLevel(model) {
  return /^gemini-3/i.test(model);
}

// Visible-answer budgets: tight for spoken answers (shorter = sooner), more
// for code. Gemini 3 counts thinking tokens against maxOutputTokens too, so
// each level gets headroom on top -- otherwise a "high" think could eat the
// whole budget and leave an empty answer. The prompt, not this cap, is what
// keeps normal answers short; the cap is the backstop.
const ANSWER_TOKENS = {
  spoken: 400,
  detailed: 900, // Shorten / Expand / other explicit instructions
  technical: 2560, // walk-through steps + full code + complexity
  chat: 1024,
  chatTechnical: 3072,
  summary: 4096,
};
const THINKING_HEADROOM_TOKENS = { minimal: 256, low: 1024, medium: 2048, high: 6144 };
// No thinkingConfig sent (2.x model, or rejected): the model thinks at its default.
const DEFAULT_THINKING_HEADROOM_TOKENS = 4096;

// ---- Per-session adaptive state ----
// thinkingRejected: the model 400'd on thinkingConfig once -> stop sending it.
// streamFailures: consecutive broken streams -> after a couple, stop trying
// to stream for this run (e.g. a proxy that buffers SSE).
const session = { thinkingRejected: false, streamFailures: 0 };
const STREAM_DISABLE_AFTER_FAILURES = 2;

function resetSessionState() {
  session.thinkingRejected = false;
  session.streamFailures = 0;
}

function geminiBody(req, withThinking) {
  const headroom = withThinking
    ? THINKING_HEADROOM_TOKENS[req.thinkingLevel] || DEFAULT_THINKING_HEADROOM_TOKENS
    : DEFAULT_THINKING_HEADROOM_TOKENS;
  return {
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    contents: [{ role: 'user', parts: req.parts }],
    generationConfig: {
      ...(req.generationConfig || {}),
      maxOutputTokens: (req.answerTokens || ANSWER_TOKENS.spoken) + headroom,
      ...(withThinking ? { thinkingConfig: { thinkingLevel: req.thinkingLevel } } : {}),
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
        body: JSON.stringify(geminiBody(req, withThinking)),
        // Covers the whole response, including reading a stream.
        signal: combineSignals(req.signal, req.timeoutMs),
      });
    } catch (err) {
      throw networkError('gemini', err, req.signal);
    }
    if (res.ok) return res;

    const info = await readProviderError(res);
    if (res.status === 400 && withThinking && attempt === 0 && looksLikeThinkingRejection(info)) {
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
async function callGemini(req) {
  if (typeof req.onChunk === 'function' && session.streamFailures < STREAM_DISABLE_AFTER_FAILURES) {
    try {
      const result = await streamGemini(req, req.onChunk);
      session.streamFailures = 0;
      return result;
    } catch (err) {
      if ((req.signal && req.signal.aborted) || !STREAM_FALLBACK_CODES.has(err.code)) throw err;
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
  const thinkingLevel = resolveThinkingLevel({ mode, quality, question: latest, hasImages });
  const technical = hasImages || looksTechnical(latest) || /```/.test(instruction || '');
  const answerTokens = technical ? ANSWER_TOKENS.technical : instruction ? ANSWER_TOKENS.detailed : ANSWER_TOKENS.spoken;

  const userText = buildConversationText({ transcript, previousAnswers, knowledgeSnippets, question: named, instruction, images });
  const result = await callGemini({
    systemPrompt: buildSystemPrompt(mode, answerStyle),
    parts: buildUserParts(userText, images),
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
    answerStyle: normalizeAnswerStyle(answerStyle),
  };
}

async function askFollowUp({
  transcript, question, previousAnswers, images, knowledgeSnippets, mode, quality, signal, onChunk,
}) {
  const hasImages = !!(images && images.length);
  const thinkingLevel = resolveThinkingLevel({ mode, quality, question, hasImages });
  const technical = hasImages || looksTechnical(question);
  const userText = buildConversationText({ transcript, previousAnswers, knowledgeSnippets, userQuestion: question, images });
  const result = await callGemini({
    systemPrompt: ASK_SYSTEM_PROMPT,
    parts: buildUserParts(userText, images),
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
  buildConversationText,
  looksTechnical,
  resolveThinkingLevel,
  createSseParser,
  _resetSessionState: resetSessionState,
};
