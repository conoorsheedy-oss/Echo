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
const interviewBrief = require('./interview-brief');
const storyBank = require('./story-bank');
const { humanizeAnswer, createStreamHumanizer } = require('./humanize');
// Pure, shared with the renderer: intent detection, the technical-question
// heuristics and the new-problem / follow-up classifier.
const intentCore = require('../renderer/intent-core');

const { looksTechnical, classifyQuestion, classifyIntent, NO_RESPONSE_SENTINEL } = intentCore;

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
const KNOWN_PHRASE_NO_SPEECH_PROB = 0.2; // stricter bar for stock phrases
const KNOWN_HALLUCINATION_PHRASES = new Set([
  'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
  'please subscribe', 'subscribe', 'bye bye', 'thank you for watching',
  "i'll see you next time", 'see you next time', 'thanks for listening',
]);

function looksLikeHallucinatedSilence(text, segments) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  const hasSegments = Array.isArray(segments) && segments.length > 0;
  // A real "Thank you." (end of an interview!) must survive: only drop a
  // stock phrase when Whisper itself isn't sure there was speech.
  if (KNOWN_HALLUCINATION_PHRASES.has(normalized)) {
    if (!hasSegments) return true;
    return segments.some((s) => typeof s.no_speech_prob === 'number' && s.no_speech_prob > KNOWN_PHRASE_NO_SPEECH_PROB);
  }
  if (hasSegments) {
    const allLowConfidence = segments.every((s) => {
      const noSpeech = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0;
      const avgLogprob = typeof s.avg_logprob === 'number' ? s.avg_logprob : 0;
      return noSpeech > NO_SPEECH_PROB_THRESHOLD || avgLogprob < AVG_LOGPROB_THRESHOLD;
    });
    if (allLowConfidence) return true;
  }
  return false;
}

async function transcribeAudio({ base64, mimeType, signal, prompt }) {
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
  // The user's own terms (stt-vocab.js), so names and specs are spelled right.
  const cleanPrompt = typeof prompt === 'string' ? prompt.trim().slice(0, 900) : '';
  if (cleanPrompt) form.append('prompt', cleanPrompt);

  let res;
  try {
    res = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      // Caller signal lets Stop/session end cancel in-flight chunks.
      signal: combineSignals(signal, STT_TIMEOUT_MS),
    });
  } catch (err) {
    throw networkError('groq', err, signal);
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
  // Whisper sometimes "transcribes" its prompt over silence.
  if (cleanPrompt && /\bjob interview\.?\s*terms\b|^terms:/i.test(text)) return '';
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
const CONTEXT_NOTE = `\nWhat you are given: the WHOLE conversation so far ("You" = the user, "Them" = the other side, oldest first; it is auto-transcribed, so expect small errors: when a word looks like a mis-hearing of a name or term in the user's background or the question, e.g. "SP 822" for "SP 800-22", use the correct one and never repeat the garbled version), the answers already suggested earlier in this session, any background and screenshots, and -- at the very end, under "LATEST" -- the last few lines and the question to answer now. Answer the latest question. Use the earlier conversation for continuity: "expand on that" or "going back to earlier" refer to what was said or answered before. Don't repeat an earlier answer word for word; build on it.`;

// Words and patterns that make an answer sound machine-written when said
// out loud. humanize.js also strips em dashes and stock openers afterwards,
// as a safety net.
const BANNED_TELLS = `Never use these AI tells: "First things first", "Great question", "That's a great question", "Great point", "I completely agree", "Certainly", "Absolutely", "I'd be happy to", "leverage", "delve", "utilize", "passionate about", "spearheaded", "synergy", "robust", "seamless", "cutting-edge", "game-changer", "it's worth noting", "in summary", "in conclusion", "overall", "furthermore", "moreover", "additionally", "I'm excited to", "thrilled", "a testament to", "navigate", "foster", "holistic", "dive into", "key takeaway", "in today's fast-paced world", "Not only X but also Y" constructions, and neat lists of three adjectives ("fast, scalable and reliable"). Never use em dashes (—): use a comma or a full stop, or start a new sentence.`;

// Highest-priority rule: sounding human must never mean making things up.
const GROUNDING = `\nTRUTH FIRST (this overrides every style rule below): only state facts about the user (projects, jobs, schools, tools, numbers, results, stories) that appear in the transcript or in their background material. If a fact isn't there, don't guess: keep it general or use a short [placeholder] they can fill in. Never add a setback, a struggle, a team size, a duration, a number or a "what it led to" just to make a story sound real. Use each number exactly as the material gives it, with what it measures; never mix figures from different places. The tone examples below use made-up facts purely to show style; never reuse any of their details. For technical facts (APIs, complexities, definitions), say only what you're confident is correct; if unsure, say so in a few words rather than guessing.`;

// Fewer, positive rules: long "don't" lists make the model perform casualness
// (every answer opening "Honestly,") and prime the very words they ban. The
// examples deliberately differ in length, shape and ending so no single
// template gets copied.
const HUMAN_VOICE = `\nVOICE. This gets said out loud by the user, so write speech, not writing.
- The user's own "You" lines in the transcript are the best guide to how they talk. Copy their vocabulary, sentence length and how casual they are, over everything else here. If there are none yet, aim for a relaxed, competent student or engineer. Match the other side's formality too (casual chat vs a formal panel).
- Write it the way it would sound if they'd thought about it for five seconds: contractions, plain words, the main point first, then the detail that makes it real. Short sentences, uneven lengths, first person ("I", or "we" for a team). A sentence can start with "And" or "But".
- One idea at a time. People don't list three adjectives or three parallel points; they say one thing, then add the next thing that comes to mind.
- Concrete over impressive: the actual tool, the actual number, what actually happened, but only ones from their facts (see TRUTH FIRST). Say numbers how people say them ("about a third", "a couple of weeks").
- Answer the question that was asked, at the size it was asked. A quick question gets one or two lines.
- Compact but specific: fewer words, more concrete detail. Cut filler and set-up, never the specifics (the actual name, number, tool or step).
- No wrap-up. Stop after the last useful detail. No moral, no summary sentence, no "and that's why...".
- Vary how answers start. Most start with the point itself; only now and then "So," or "Yeah,". Never open by praising the question or repeating it back.
- Real hedges only where a person would hedge ("I think", "if I remember right"). Be plainly confident about the user's own facts.
- Agree or disagree the way the user honestly would, with a reason, never as a reflex.
- ${BANNED_TELLS}

Examples. TONE only, the facts are made up: never reuse them. Notice they're all different shapes.
Q: "Tell me about a project you're proud of."
"Probably the payments rewrite.
We had one big service that took a week to deploy, so I split it into three.
Took about two months, and now we ship most days."

Q: "Why did you use a hash map there?"
"Mainly for the lookups.
Checking if I've seen a number is constant time instead of scanning the list again."

Q: "What's your biggest weakness?"
"I used to say yes to everything.
Last term that meant one project slipped, and I hated that.
So now I look at my week before I take anything on."

Q: "Any questions for us?"
"Yeah, what does the first month look like for someone on this team?"`;

// Answer style (Settings > Answer style; renderer sends answerStyle).
// SCRIPT: full sentences to read out. CUES: a first line to say, then
// keyword prompts the user talks around in their own words.
const ANSWER_STYLES = new Set(['script', 'cues']);

const SCRIPT_STYLE = `\nAnswer style: SCRIPT. The user will say this out loud, glancing at it mid-conversation:
- Start with ONE short headline sentence that directly answers the question, in the user's own voice, on its own line, followed by a blank line. It should work on its own if that's all they manage to say.
- Then 1-3 more short spoken sentences, ONE sentence per line (a line break after every sentence), each under about 15 words so it can be said after one glance. One idea per line. Nothing the user would stumble over saying. No menu of options.
- When relevant, include a concrete result or outcome (a number, what changed, what it led to).
- Minimal formatting: plain sentences. No headings, no bullet lists, no tables, no LaTeX. You may **bold** one or two key words (never whole sentences).
- Never invent projects, employers, numbers or experience that aren't in the transcript or the user's background material. If a detail is missing, keep it general.`;

const CUES_STYLE = `\nAnswer style: CUES. The user wants prompts to talk around in their own words, not a script to read:
- Line 1: ONE short headline sentence they can say straight away, directly answering the question, in their own voice. Then a blank line.
- Then 3-4 cue lines. Each starts with "- " and a **bold keyword or short phrase** (2-4 words), optionally followed by a few plain words of detail (a number, a name, a result). Fragments only: no full sentences, no explanations, no filler.
- Put the cues in the order the user should talk through them.
- No headings, no tables, no LaTeX, and nothing after the cues.
- Never invent projects, employers, numbers or experience that aren't in the transcript or the user's background material. If a detail is missing, keep the cue general.
Example of the format (facts made up, never reuse them):
"I'd start with the payments migration I did last summer.

- **Old monolith** slow weekly deploys
- **Split into 3 services** over two months
- **Result** deploys most days, no more Friday pages"`;

const TECHNICAL_STYLE = `\nCoding, maths, probability, puzzles and system design (in either answer style). There are two kinds of technical question, and they get different formats. These rules override the format rules above for these questions only.
A) A NEW problem to solve (a coding task, a maths/probability question, a puzzle, "design a system"). Interviewers want to hear HOW the user thinks, not just the final answer, so show the thought process the user can say out loud while working:
1. Line 1: ONE short clarifying question the user asks before solving, so they engage instead of jumping to code: about something the problem doesn't already state (input size or constraints, an edge case like empty input, duplicates or negatives, or what time complexity they're hoping for; for design, the scale or the main requirement). Then a blank line. Skip it only for maths / probability / puzzles where nothing is unclear.
   Then one line: a one-line spoken summary of the approach (what the user says once they have the answer), then a blank line.
2. A short "thinking out loud" walk-through as a numbered list (3-4 items). Each item starts with a **bold cue of 1-3 words** (e.g. **Brute force**, **Key insight**, **Storage**), then one short spoken line in the user's voice, under about 12 words, so the user can glance at the cue and say it in their own words. Never write "first", "second", "then three": each item must make sense on its own. For code, roughly: what the input/output is and any edge case worth checking; the simple brute-force idea and why it's too slow (with its complexity); the key insight that makes it better; the plan for the final approach. For maths/probability: what's being asked, the setup, then the key steps. For system design: the requirements to confirm, the core components, the main trade-off.
3. Then what's needed to actually solve it: for code, ONE complete, correct code block in the language (and method signature) shown on screen if there is one, nothing left out, with short comments on the key lines (what a step does or why, a few words each, about 3-6 in total, not one on every line); for maths/probability, the final answer with the number; for design, the final design in a few short lines.
4. End with one line on time/space complexity where it applies, and optionally one line on how to quickly test it with a small example.
Trade-offs: one plain contrast the user can say in one breath ("A sliding log is exact but stores every timestamp, so I'd use a counter"), never a list of pros and cons. Formulas and counters: say the formula in words once, and double-check it and every increment / decrement before writing it; a wrong sign or weight is worse than no formula.
B) A FOLLOW-UP about a solution or code already discussed ("why did you use X", "what if the input is empty", "what's the complexity", "how would you test it", "any edge cases", "can you explain this part"), or a quick conceptual question. Answer it like a person in the room would: the headline sentence with the direct answer, then 1-3 short spoken lines with the reasoning. No numbered walk-through, and don't repeat the full code. Only if the answer changes the code, add one tiny code block with just the changed lines. Use the earlier answers in this session to know what the code is.
Failure-case follow-ups (a crash, a retry, a timeout, two requests at once): say what state is written before the risky step, how it recovers after (check that state, or reconcile with the other system), and what stops two at once (a unique key or a lock). Name the one or two cases that matter most, not a list.
Scaling follow-ups (a stream, memory limits, very large data, several machines): name the concrete technique and how the pieces combine (for example each machine keeps its own partial result and they are merged), and finish the thought; never stop at "we'd need something distributed".
Every complexity you state must match the operations it describes (check it before writing it).
Spoken lines never contain code: no identifiers with underscores or camelCase, no brackets, quotes or operators. Say what it does in plain words ("a set of the IDs I've seen", "the first element"), never its name or syntax. Code only goes inside the code block, which the user types or shows rather than reads out.
Keep every line plain and spoken (same voice rules as above). In CUES style, keep the numbered steps as short fragments rather than sentences.`;

function normalizeAnswerStyle(style) {
  return typeof style === 'string' && ANSWER_STYLES.has(style) ? style : 'script';
}

// ---- Mode-specific rules ----
// One shared core (truth, voice + tone examples, answer style, context /
// screen / knowledge notes) plus ONE block per mode. Per-request details
// (the intent, auto vs asked-for) go in the LATEST section instead, so the
// system prompt stays identical for every request in a (mode, style) pair
// and Gemini's prefix caching keeps working.
const MODES = intentCore.MODES; // interview | meeting | presentation | general

function normalizeMode(mode) {
  return intentCore.normalizeMode(mode);
}

// Automatic suggestions outside interviews may decline (suggest-pipeline.js
// drops the request silently). Explicit requests never get this option.
const NO_RESPONSE_NOTE = `\n- Automatic suggestions: only when the LATEST section says this suggestion was triggered automatically, and there is genuinely nothing useful for the user to say (small talk, an update that needs no reply, a remark aimed at someone else), reply with exactly ${NO_RESPONSE_SENTINEL} and nothing else. When the user asked for the answer themselves, always give a useful reply.`;

const STAR_SCRIPT = '- For behavioural "tell me about a time" questions use a compressed STAR shape, about 30 seconds out loud: the situation in a clause (name the actual technical choice or problem in the first line), what I did, and end on the result. When a team or a lead was involved, make the user\'s own part explicit ("I did X; my lead did Y"), using only what the material says. Never make another person look bad (careless, dishonest, hiding something): a disagreement is two reasonable views, how it was settled, and what the user took from it.';
const STAR_CUES = '- For behavioural "tell me about a time" questions follow STAR (situation, what I did, result), about 30 seconds out loud; the first cue names the actual technical choice or problem, one cue says what the user did themselves (not the team), and the last cue is the concrete result. Never make another person look bad: a disagreement is two reasonable views and how it was settled.';

// Interview only (Phase 2b): how to read the INTERVIEW STATE block and the
// "Direction:" line that main.js adds to the user message. Fixed text, so
// the system prompt is still identical for every request (prefix caching).
const INTERVIEW_STATE_NOTE = `
- An INTERVIEW STATE block may come after the background, with a source label on every line: [Interviewer] = what the interviewer said, verbatim. [You said] = the candidate's own words, verbatim, and [You said — confirmed: "x"] = a detail the candidate actually said out loud. [From CV: file] = from the user's own files. [Echo suggested — not confirmed] = what you suggested earlier; the candidate may not have used any of it. [Inferred from the wording] = a best guess at which earlier question this one is about. Only [You said] and [From CV] are facts about the user.
- Answer follow-ups in terms of what the candidate actually said ([You said]); if that differs from [Echo suggested], follow the candidate's version and don't contradict them. Never treat [Echo suggested — not confirmed] as something the user did or said. When the state says a question may refer to two threads, pick the reading the wording supports best. LATEST may also have a "Direction:" line: follow it unless the wording of the question clearly says otherwise.`;

const MODE_NOTES = {
  interview: (style) => `\nInterview rules:
${style === 'cues' ? STAR_CUES : STAR_SCRIPT}
- Questions about the user's own experience: use their real facts from the transcript or background; if there are none, use short [placeholders] (see TRUTH FIRST).${INTERVIEW_STATE_NOTE}${TECHNICAL_STYLE}`,
  meeting: () => `\nMeeting rules. You're helping the user contribute to a group discussion, not answer an exam:
- Say something worth saying: a clear position, a concrete suggestion, a useful next step, or a sharp question. Sometimes the best contribution is a good question, and then the first line is that question.
- Asked for an opinion: take a clear position and give one reason. Honest hedging is fine ("I'd lean towards X, mainly because Y"); being vague is not.
- Someone disagreed with the user: acknowledge their point briefly, then either hold the position with a reason, concede the part they're right about, or suggest a quick way to test it. Never automatically defensive, never automatically agreeing.
- A proposal: respond constructively with one real benefit, one risk or useful question, or a way to improve it.
- Asked for ideas: one or two concrete suggestions, not a long list.
- Someone describes a problem or blocker: a useful next step, or a clarifying question.
- Asked to clarify: restate the point simply, in different words.
- Keep it short: 1-3 lines, plain and conversational, like talking to colleagues. Don't summarise the meeting back to them and don't restate what they just said.
- Only go technical (code, numbers, a design) when the discussion is technical, and then give the complete thing. Don't turn it into an interview-style story unless someone asks about the user's past experience.${NO_RESPONSE_NOTE}`,
  presentation: () => `\nPresentation rules:
- Give short talking points the user can say aloud while presenting, not an essay.
- An audience question: answer it directly in the first line, then one supporting point (a fact, example or number from their material). If it's outside what they know, say so honestly and offer to follow up.
- If the user seems lost or asks to get back on track, give a one-line bridge back to their main point, then the next thing to say.
- Technical questions: answer directly; include code or working only when it's asked for, and then complete.
- No interview-style stories or answer shapes.${NO_RESPONSE_NOTE}`,
  general: () => `\nConversation rules:
- Reply the way a person naturally would: answer, explain, suggest, or ask a short follow-up question back, whichever fits.
- Asked for an opinion: a clear position and one reason. If they push back, acknowledge it, then hold your view with a reason, concede part, or suggest how to check.
- Code, a draft or a full explanation: give the complete thing.
- No interview framing and no interview-style stories.${NO_RESPONSE_NOTE}`,
};

// The shared core around one mode block. The mode block sits where the
// technical rules used to be (after the answer style, before the notes on
// what the request carries).
function commonNotes(answerStyle, mode = 'interview') {
  const styleName = normalizeAnswerStyle(answerStyle);
  const style = styleName === 'cues' ? CUES_STYLE : SCRIPT_STYLE;
  const modeNotes = MODE_NOTES[normalizeMode(mode)](styleName);
  return `${GROUNDING}${HUMAN_VOICE}${style}${modeNotes}${CONTEXT_NOTE}${SCREEN_NOTE}${KNOWLEDGE_NOTE}`;
}

const MODE_INTROS = {
  interview: `You are a live interview co-pilot. The user is in a real interview right now and will answer in their own voice, using what you write. Ground answers in the user's real background if it appears in the transcript or context.`,
  meeting: `You are a live meeting co-pilot. Suggest what the user could say right now: the headline is their contribution in one sentence (an answer, a position, or a useful question), with a little support after it. Only go longer if the moment clearly calls for it (e.g. drafting text, or working through a problem shown on screen), and then give the complete thing.`,
  presentation: `You are a live presentation co-pilot helping the user answer audience questions or stay on track. Give a short, confident talking-point answer to the most recent question.`,
  general: `You are a live conversation co-pilot. Suggest a short, useful response to whatever was just said or asked. If the request clearly calls for something longer (e.g. code, a full draft), give the complete thing rather than a truncated version.`,
};

const ASK_SYSTEM_PROMPT = `You are a live conversation co-pilot's chat panel. The user is asking you a quick question about their current live conversation. Answer directly and completely using the transcript, the user's own background material, and any attached screenshots (whichever are present) for context. If the answer calls for code or a full explanation, give the complete version rather than a truncated one. You get the whole conversation so far (oldest first), the answers already given in this session, and the user's question at the end under "LATEST". Use the earlier context for follow-ups ("what did they mean earlier?", "expand on your last answer").
${GROUNDING}
Write the way a sharp friend would reply: plain words, contractions, short sentences, straight to the point, no preamble. If you suggest something for the user to say, write it the way they'd actually say it out loud, in the first person.
When the user types a question for you to answer AS THEM (an interview question like "tell me about something you're proud of", or "what should I say?"), reply with only the words they'd say out loud:
- No intro line ("Here's an answer you can give"), no quotation marks around it, no closing moral or lesson ("It showed me how to...", "It was really rewarding..."). Stop after the last real detail.
- The size of a real spoken answer: a one-line headline, then 2-4 short lines; a behavioural story stays under about 45 seconds. Longer only if they ask for it.
- One real story from their files or the transcript (if a STORY BANK is given, use one of its stories). Every fact must be in that material: no extra numbers, team sizes, durations, results, setbacks or "what changed after" that it doesn't state. If a detail isn't there, leave it out or use a short [placeholder].
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

// Unknown modes (including "__proto__") fall back to general.
function buildSystemPrompt(mode, answerStyle) {
  const m = normalizeMode(mode);
  return `${MODE_INTROS[m]}${commonNotes(answerStyle, m)}`;
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
  problem: 'Question type: a NEW problem to solve. Use the full technical format (a clarifying question to ask first, the spoken approach line, short numbered walk-through, then the complete commented code or final answer, then complexity).',
  followup: 'Question type: a FOLLOW-UP about the solution or code already discussed (or a quick conceptual question). Keep it short and spoken: the headline sentence with the direct answer, then 1-3 short lines. No numbered walk-through and no full code again; at most one tiny code block with just the changed lines if the answer changes the code.',
};

// Interview mode keeps the KIND_HINTS above exactly as before. Other modes
// get a one-line hint for the detected intent instead (the system prompt's
// mode block explains each), plus a technical nudge for a new problem.
const INTENT_HINTS = {
  direct_question: 'Intent: a direct question. Answer it in the first line.',
  opinion_request: "Intent: they want the user's opinion. Take a clear position and give one reason.",
  follow_up: "Intent: a follow-up on what was just discussed. Build on it; don't repeat it.",
  disagreement: 'Intent: disagreement, possibly with something the user said. Respond thoughtfully, not defensively: acknowledge it, then hold the position with a reason, concede part, or suggest a way to test it.',
  proposal: 'Intent: a proposal. Respond constructively: a real benefit, a risk or useful question, or an improvement.',
  suggestion_request: "Intent: they're asking for ideas. Give one or two concrete suggestions.",
  clarification_request: 'Intent: they want clarification. Restate the point simply, in different words.',
  problem: 'Intent: someone described a problem or blocker. Offer a useful next step or a clarifying question.',
  information_sharing: "Intent: an update or statement with no direct ask. Only add something genuinely useful: a relevant point or question, not an acknowledgement.",
  explanation_request: 'Intent: they want an explanation. Explain simply, key idea first.',
  behavioural_question: "Intent: a question about the user's own experience. Ground it in their real facts, or use [placeholders].",
  technical_question: 'Intent: a technical question. Give the direct answer first, then the code or working if it is needed, complete.',
  no_response: 'Intent: nothing was really asked (a filler or an acknowledgement).',
};
const OTHER_MODE_PROBLEM_HINT = 'Question type: a technical problem to solve. Give the approach in the first line, then the complete code or final answer, then a line on complexity if it applies.';
const AUTO_NO_RESPONSE_HINT = `This suggestion was triggered automatically (the user didn't ask for it). If there is genuinely nothing useful for the user to say here, reply with exactly ${NO_RESPONSE_SENTINEL} and nothing else.`;

// "Do you have any questions for me / us?" at the end of an interview.
const INVITES_QUESTIONS_RE = /\b(?:any|some|other|more|final|last)\s+questions?\s+(?:for\s+(?:me|us|the team|them)|about\s+(?:the\s+)?(?:role|company|team|position|job|us|me))\b|\b(?:anything|something)\s+(?:else\s+)?you(?:'d| would)?\s+(?:like|want)\s+to\s+ask(?:\s+(?:me|us))?\s*[?.!]*\s*$|\bwhat\s+questions\s+(?:do\s+you\s+have|have\s+you\s+got)\s+for\s+(?:me|us)\b|\b(?:do\s+you\s+have|got)\s+(?:any\s+)?questions\s*[?.!]*\s*$/i;
function invitesQuestions(question) {
  return INVITES_QUESTIONS_RE.test(String(question || ''));
}
const ASK_THEM_HINT = "They're inviting the user's questions. Never say there are none. Give 2 short, genuine questions the user could ask, one per line (about the team, the day-to-day work, what success looks like in the first months, or what the interviewer enjoys about working there), tailored to the role in the brief if there is one. Don't state facts about the company that aren't in the brief or the conversation.";

// The per-request format hints for LATEST (full answer).
function latestHints({ mode, kind, intent, allowNoResponse, question }) {
  const hints = [];
  if (!mode || mode === 'interview') {
    if (invitesQuestions(question)) hints.push(ASK_THEM_HINT);
    else if (kind && KIND_HINTS[kind]) hints.push(KIND_HINTS[kind]);
    return hints;
  }
  if (kind === 'problem') hints.push(OTHER_MODE_PROBLEM_HINT);
  if (intent && Object.prototype.hasOwnProperty.call(INTENT_HINTS, intent)) hints.push(INTENT_HINTS[intent]);
  if (allowNoResponse) hints.push(AUTO_NO_RESPONSE_HINT);
  return hints;
}

// Layout, built for Gemini's implicit (prefix) caching and for "the question
// is never buried":
//   [system instruction]                       identical for every request in a mode/style
//   0. INTERVIEW BRIEF                         interview only, if the user filled one in: fixed all session
//   1. FULL CONVERSATION SO FAR                append-only -> the long, stable prefix
//   2. ANSWERS ALREADY GIVEN                   append-only
//   3. background snippets (knowledge files)   re-ranked per question
//   3a. STORY BANK                             interview only: a NEW behavioural question's best real stories
//   3b. INTERVIEW STATE block                  interview only (Phase 2b): thread state with source labels
//   4. screenshots note + the screenshots      (separate image parts)
//   5. "=== LATEST ===" last lines + the question + "Direction:" line (interview only) + instruction + format hint
// The transcript is by far the biggest block and only ever grows at its end,
// so consecutive requests share everything up to its old end. Blocks that
// change on (almost) every question -- the knowledge snippets, which are
// searched with the question itself, and the newest answer -- go after it;
// putting them first would make the shared prefix stop at the system prompt.
// Returns { context, latest } text; buildUserParts() puts images between them.
// mode / intent / allowNoResponse: see latestHints() (no mode = the
// interview hints, as before).
// stateBlock / direction: interview mode only (interviewStateFor()); absent
// means the prompt is exactly what it was before Phase 2b.
// briefBlock: interview mode only (briefFor()); absent = no brief, no change.
function buildConversation({ transcript, previousAnswers, knowledgeSnippets, question, userQuestion, instruction, images, kind, mode, intent, allowNoResponse, stateBlock, direction, briefBlock, storyBlock }) {
  const capped = capTranscript(transcript);
  let context = briefBlock ? `${briefBlock}\n\n` : '';
  context += `FULL CONVERSATION SO FAR (chronological, oldest first; "You" = the user, "Them" = the other side):\n\n${capped || '(no transcript yet)'}`;
  context += buildPreviousAnswersBlock(previousAnswers);
  // Stories are background too: don't also say "no background was provided".
  if (!storyBlock || (knowledgeSnippets && knowledgeSnippets.length)) context += buildKnowledgeBlock(knowledgeSnippets);
  if (storyBlock) context += `\n\n${storyBlock}`;
  if (stateBlock) context += `\n\n${stateBlock}`;
  context += describeScreenshots(images);
  let latest = '=== LATEST ===';
  const tail = capped ? latestLines(capped) : '';
  if (tail) latest += `\nLast lines of the conversation:\n${tail}`;
  if (userQuestion) latest += `\n\nUser's question to you: ${userQuestion}`;
  else if (question) latest += `\n\nQuestion to answer now (asked by Them): "${question}"`;
  else latest += '\n\nAnswer whatever was most recently asked or said above.';
  if (direction) latest += `\n\n${direction}`;
  if (instruction) latest += `\n\nAdditional instruction from the user: ${instruction}`;
  for (const hint of latestHints({ mode, kind, intent, allowNoResponse, question })) latest += `\n\n${hint}`;
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

// looksTechnical() and classifyQuestion() ('problem' | 'followup' |
// 'general') live in src/renderer/intent-core.js, shared with the renderer's
// intent layer; see the import at the top of this file.

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
  if (instruction) return ANSWER_TOKENS.detailed;
  return kind === 'followup' ? ANSWER_TOKENS.followUp : ANSWER_TOKENS.spoken;
}

// ---- Per-session adaptive state ----
// Per model (the first line can use a different model from the answers, see
// headlineModel(), so one model's quirks never change the other's requests):
//   thinkingRejected: the model 400'd on thinkingConfig -> stop sending it.
//   minimalRejected: the model only refused the 'minimal' level (some models
//   don't have it) -> use 'low' for those requests instead, and keep thinking
//   control for everything else.
// streamFailures: consecutive broken streams -> after a couple, stop trying
// to stream for this run (e.g. a proxy that buffers SSE).
const session = { thinking: new Map(), streamFailures: 0 };
const STREAM_DISABLE_AFTER_FAILURES = 2;

function thinkingState(model) {
  let state = session.thinking.get(model);
  if (!state) {
    state = { thinkingRejected: false, minimalRejected: false };
    session.thinking.set(model, state);
  }
  return state;
}

function resetSessionState() {
  session.thinking.clear();
  session.streamFailures = 0;
}

// Google: Gemini 3 is tuned for the default temperature (1.0); lowering it
// can cause looping / worse reasoning. So callers' temperatures only apply
// to older models.
function generationConfigFor(model, config) {
  const cfg = { ...(config || {}) };
  if (supportsThinkingLevel(model)) delete cfg.temperature;
  return cfg;
}

function geminiBody(req, withThinking, level = req.thinkingLevel, model = geminiModel()) {
  const headroom = withThinking
    ? THINKING_HEADROOM_TOKENS[level] || DEFAULT_THINKING_HEADROOM_TOKENS
    : DEFAULT_THINKING_HEADROOM_TOKENS;
  return {
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    contents: [{ role: 'user', parts: req.parts }],
    generationConfig: {
      ...generationConfigFor(model, req.generationConfig),
      maxOutputTokens: (req.answerTokens || ANSWER_TOKENS.spoken) + headroom,
      ...(withThinking ? { thinkingConfig: { thinkingLevel: level } } : {}),
    },
  };
}

function looksLikeThinkingRejection(info) {
  return /thinking/i.test(`${info.message} ${info.raw}`);
}

// POSTs to models/<model>:<endpoint> (req.model, else GEMINI_MODEL). If the
// model rejects thinkingConfig (HTTP 400 that mentions "thinking"), retries
// without it -- or, if only 'minimal' was refused, at 'low' first -- and
// remembers that for this model for the rest of the session.
async function postGemini(endpoint, req) {
  const apiKey = keyStore.getKey('gemini');
  if (!apiKey) throw missingKeyError('gemini');
  const model = safeModelName(req.model || geminiModel());
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:${endpoint}`;
  const quirks = thinkingState(model);
  let withThinking =
    !!req.thinkingLevel && THINKING_LEVELS.has(req.thinkingLevel) && supportsThinkingLevel(model) && !quirks.thinkingRejected;
  let level = req.thinkingLevel === 'minimal' && quirks.minimalRejected ? 'low' : req.thinkingLevel;

  // minimal -> low -> no thinkingConfig: at most three tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          // Header, not ?key= in the URL, so the key can't end up in any URL log.
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(geminiBody(req, withThinking, level, model)),
        // Covers the whole response, including reading a stream.
        signal: combineSignals(req.signal, req.timeoutMs),
      });
    } catch (err) {
      throw networkError('gemini', err, req.signal);
    }
    if (res.ok) return res;

    const info = await readProviderError(res);
    if (res.status === 400 && withThinking && looksLikeThinkingRejection(info)) {
      if (level === 'minimal') {
        // Only this level is unsupported: don't give up thinking control
        // for the full answers too.
        quirks.minimalRejected = true;
        level = 'low';
        console.warn(`[ai] Gemini rejected thinkingLevel "minimal" for ${model} -- using "low" for those requests.`);
        continue;
      }
      quirks.thinkingRejected = true;
      withThinking = false;
      console.warn(`[ai] Gemini rejected thinkingConfig for ${model} -- retrying without it for the rest of this session.`);
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

// How many "Them" lines since the user last spoke (this transcript has no
// timestamps, so only the line count is known).
function recentYouFromTranscript(transcript) {
  const lines = String(transcript || '').trim().split('\n').filter((l) => l.trim());
  let themLinesSince = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^You:/.test(lines[i])) return { themLinesSince };
    if (/^Them:/.test(lines[i])) themLinesSince += 1;
  }
  return null;
}

// Worked out ONCE per suggestion (suggest-pipeline.js) and passed to both
// the full answer and the instant first line, so they read the question the
// same way:
//   questionKind     classifyQuestion(): problem | followup | general
//   intent           the renderer's intent if it sent a valid one, else
//                    classifyIntent() on the same text
//   allowNoResponse  an automatic request outside interviews: the model may
//                    answer with the NO_RESPONSE sentinel
function analyzeSuggestion({ transcript, mode, question, previousAnswers, images, intent, requestKind } = {}) {
  const m = normalizeMode(mode);
  const named = String(question || '').trim();
  const latest = named || latestUtterance(transcript);
  const hasImages = !!(images && images.length);
  const prior = priorContext(previousAnswers);
  const questionKind = classifyQuestion(latest, { hasImages, ...prior });
  let finalIntent = intentCore.isIntent(intent) ? intent : null;
  if (!finalIntent) {
    finalIntent = classifyIntent(latest, {
      mode: m,
      speaker: 'them',
      prior: { hasPriorAnswer: prior.hasPriorAnswer, lastAnswerTechnical: prior.priorCode },
      recentYou: recentYouFromTranscript(transcript),
      hasImages,
    }).intent;
  }
  return {
    mode: m,
    questionKind,
    intent: finalIntent,
    allowNoResponse: requestKind === 'auto' && m !== 'interview',
  };
}

// The analysis fields above, or worked out here when the caller (a test,
// or anything other than suggest-pipeline.js) didn't pass them.
function suggestionAnalysis(params) {
  const mode = normalizeMode(params.mode);
  if (params.questionKind && intentCore.isIntent(params.intent) && typeof params.allowNoResponse === 'boolean') {
    return {
      mode,
      questionKind: params.questionKind,
      intent: params.intent,
      allowNoResponse: params.allowNoResponse && mode !== 'interview',
    };
  }
  const fresh = analyzeSuggestion(params);
  return {
    mode: fresh.mode,
    questionKind: params.questionKind || fresh.questionKind,
    intent: intentCore.isIntent(params.intent) ? params.intent : fresh.intent,
    allowNoResponse: typeof params.allowNoResponse === 'boolean' ? params.allowNoResponse && fresh.mode !== 'interview' : fresh.allowNoResponse,
  };
}

// The interview state (main.js: interview-session.buildInterviewState(),
// computed once per request) for the full answer (`block`) and the first
// line (`headlineBlock`, a trimmed subset); `direction` is the same line for
// both. Interview mode only: other modes never get any of it.
function interviewStateFor(mode, state, { headline = false } = {}) {
  if (mode !== 'interview' || !state || typeof state !== 'object') return { block: '', direction: '' };
  const block = headline ? state.headlineBlock : state.block;
  return {
    block: typeof block === 'string' ? block : '',
    direction: typeof state.direction === 'string' ? state.direction : '',
  };
}

// The interview brief (main.js: interview-brief.js blocks, worked out once
// per request): `block` for the full answer, `headlineBlock` (shorter) for
// the first line, `type` for the thinking level. Interview mode only.
function briefFor(mode, brief, { headline = false } = {}) {
  if (mode !== 'interview' || !brief || typeof brief !== 'object') return { block: '', type: 'auto' };
  const block = headline ? brief.headlineBlock : brief.block;
  return {
    block: typeof block === 'string' ? block : '',
    type: interviewBrief.TYPES.includes(brief.type) ? brief.type : 'auto',
  };
}

// The story bank picks for this question (main.js: story-store.js plan()).
// Interview mode only; anything malformed -> nothing.
function storiesFor(mode, stories) {
  if (mode !== 'interview' || !stories || typeof stories !== 'object') return { block: '', line: '' };
  return {
    block: typeof stories.block === 'string' ? stories.block : '',
    line: typeof stories.headlineLine === 'string' ? stories.headlineLine : '',
  };
}

async function generateSuggestion(params) {
  const {
    transcript, instruction, question, previousAnswers, images, knowledgeSnippets, quality, answerStyle, signal, onChunk,
  } = params;
  const named = String(question || '').trim();
  const { mode, questionKind: kind, intent, allowNoResponse } = suggestionAnalysis(params);
  const { block: briefBlock, type: interviewType } = briefFor(mode, params.brief);
  const thinkingLevel = interviewBrief.adjustThinkingLevel(
    resolveThinkingLevel({ mode, quality, kind }),
    { type: interviewType, kind, quality: normalizeQuality(quality), question: mode === 'interview' ? named : '' }
  );
  const answerTokens = answerTokensFor(kind, instruction);

  const { block: stateBlock, direction } = interviewStateFor(mode, params.interviewState);
  const conversation = buildConversation({
    transcript, previousAnswers, knowledgeSnippets, question: named, instruction, images, kind, mode, intent, allowNoResponse, stateBlock, direction, briefBlock,
    storyBlock: storiesFor(mode, params.stories).block,
  });
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
    intent,
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

// Mode-specific lines for the first sentence, matching MODE_NOTES.
const HEADLINE_MODE_RULES = {
  interview: `\n- If an INTERVIEW STATE block is given, only [You said] and [From CV] lines are facts about the user; never present [Echo suggested — not confirmed] as something they said or did. If the candidate's own version differs from Echo's, follow the candidate's. Follow the "Direction:" line in LATEST.`,
  meeting: `\n- In a meeting the first line can be a position, a concrete suggestion or a short question back. If someone pushed back on the user, acknowledge it and respond with a reason; never just agree, never get defensive. Don't open by praising or agreeing with their point.`,
  presentation: `\n- An audience question: answer it directly. If the user seems lost, a short bridge back to their main point.`,
  general: `\n- A natural reply: answer, suggest, or ask a short question back.`,
};
const HEADLINE_NO_RESPONSE_RULE = `\n- Only if the LATEST section says this was triggered automatically and there's genuinely nothing useful to say: reply with exactly ${NO_RESPONSE_SENTINEL} and nothing else.`;

function buildHeadlineSystemPrompt(mode) {
  const m = normalizeMode(mode);
  const situation = HEADLINE_SITUATIONS[m];
  const modeRules = `${HEADLINE_MODE_RULES[m]}${m === 'interview' ? '' : HEADLINE_NO_RESPONSE_RULE}`;
  return `${situation} Give ONLY the first sentence the user should say out loud right now, in their own voice, in reply to the latest question. A fuller answer is being written separately and follows a moment later; your sentence is what they start talking with while it loads.
- Exactly one short spoken sentence (under 25 words), first person, contractions, plain everyday words. It directly answers the question, or opens the answer, and works on its own. It should sound like how a real person naturally starts talking, not a polished opening line.
- No preamble, no quotation marks around it, no labels, no markdown, no lists, no code.
- A NEW coding or design problem: one short clarifying question to ask them first, about something the problem doesn't already state (input size, an edge case, or the time complexity they're hoping for; for design, the scale). A maths or probability problem: say how you'd start. Never state a final number or claim you aren't sure of.
- A follow-up about code already discussed (why X, what if, complexity, testing, edge cases): the direct answer in one line, consistent with the earlier answers.
- Ground it in the conversation and the user's background. Never invent projects, employers, numbers or experience: if the question is about their experience and no matching fact is given, use a short [placeholder] instead.${modeRules}
- ${BANNED_TELLS}`;
}

// Last ~8k chars of the transcript (whole lines), the latest question, the
// last couple of answers (they hold the code a follow-up is about) and the
// knowledge snippets -- enough to say the right first sentence, small enough
// to be quick.
function buildHeadlineConversation({ transcript, previousAnswers, knowledgeSnippets, question, instruction, images, kind, mode, intent, allowNoResponse, stateBlock, direction, briefBlock, storyLine }) {
  const recent = capTranscript(transcript, HEADLINE_TRANSCRIPT_CHARS);
  let context = briefBlock ? `${briefBlock}\n\n` : '';
  context += `RECENT CONVERSATION (oldest first; "You" = the user, "Them" = the other side):\n\n${recent || '(no transcript yet)'}`;
  if (Array.isArray(previousAnswers) && previousAnswers.length) {
    const lastFew = previousAnswers.slice(-HEADLINE_PREVIOUS_ANSWERS)
      .map((a) => ({ ...a, text: clip(a.text, HEADLINE_PREVIOUS_ANSWER_CHARS) }));
    context += buildPreviousAnswersBlock(lastFew);
  }
  if (!storyLine || (knowledgeSnippets && knowledgeSnippets.length)) context += buildKnowledgeBlock(knowledgeSnippets);
  if (storyLine) context += `\n\n${storyLine}`;
  if (stateBlock) context += `\n\n${stateBlock}`;
  context += describeScreenshots(images);
  let latest = '=== LATEST ===';
  const tail = recent ? latestLines(recent) : '';
  if (tail) latest += `\nLast lines of the conversation:\n${tail}`;
  if (question) latest += `\n\nQuestion to answer now (asked by Them): "${question}"`;
  else latest += '\n\nAnswer whatever was most recently asked or said above.';
  if (direction) latest += `\n\n${direction}`;
  if (instruction) latest += `\n\nAdditional instruction from the user: ${instruction}`;
  if ((!mode || mode === 'interview') && invitesQuestions(question)) latest += "\n\nThey're inviting the user's questions: give the first good question the user could ask them (never \"no questions\").";
  else if (kind === 'problem') latest += '\n\nThis is a new problem to solve.';
  else if (kind === 'followup') latest += '\n\nThis is a follow-up about what was already discussed.';
  if (mode && mode !== 'interview') {
    if (intent && Object.prototype.hasOwnProperty.call(INTENT_HINTS, intent)) latest += `\n\n${INTENT_HINTS[intent]}`;
    if (allowNoResponse) latest += `\n\n${AUTO_NO_RESPONSE_HINT}`;
  }
  latest += '\n\nReply with ONLY the first sentence the user should say.';
  return { context, latest };
}

// First sentence of the headline reply, without wrapping quotes.
// Don't end the sentence on these ("I'd use e.g. a heap" stays whole).
const NON_FINAL_ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|mr|mrs|ms|dr|st)\.$/i;

function firstSpokenSentence(text) {
  let t = String(text || '').trim().split('\n').find((l) => l.trim()) || '';
  t = t.trim().replace(/^["'“‘]+/, '');
  const re = /[.!?]["'”’]*(?=\s|$)/g;
  let m;
  while ((m = re.exec(t))) {
    const candidate = t.slice(0, m.index + 1);
    if (m[0][0] === '.' && NON_FINAL_ABBREVIATIONS.test(candidate)) continue;
    return candidate.replace(/["'”’]+$/, '').trim();
  }
  return t.replace(/["'”’]+$/, '').trim();
}

// ---- Which model writes the first line ----
// Only the first line changes model; full answers, chat and summaries always
// use GEMINI_MODEL. In order:
//   1. GEMINI_HEADLINE_MODEL in .env, if set.
//   2. The newest STABLE Gemini Flash-Lite this key can use, looked up once
//      per app run from Gemini's model list (models/gemini-<version>-flash-lite
//      that supports generateContent; no -preview / -exp / dated ids).
//      The lookup starts at the first headline request and never delays it:
//      until it has finished, that request uses GEMINI_MODEL.
//   3. GEMINI_MODEL (no stable Flash-Lite, the lookup failed, or the chosen
//      model 404'd -- then it's skipped for the rest of the run).
// A failed lookup is retried after HEADLINE_DISCOVERY_RETRY_MS.
const FLASH_LITE_NAME_RE = /^models\/gemini-(\d+(?:\.\d+)?)-flash-lite$/;
const HEADLINE_DISCOVERY_RETRY_MS = 10 * 60_000;
const HEADLINE_DISCOVERY_MAX_PAGES = 10;
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

const headlineDiscovery = { status: 'idle', model: null, failedAt: 0, promise: null }; // status: idle | pending | done | failed
const badHeadlineModels = new Set(); // 404'd as the first-line model this run

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Gemini's models list -> 'gemini-<newest version>-flash-lite', or null.
function pickHeadlineModel(models) {
  let best = null;
  let bestVersion = null;
  for (const m of Array.isArray(models) ? models : []) {
    const match = m && typeof m.name === 'string' ? FLASH_LITE_NAME_RE.exec(m.name) : null;
    if (!match) continue;
    if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;
    const version = match[1].split('.').map(Number);
    if (!best || compareVersions(version, bestVersion) > 0) {
      best = m.name.slice('models/'.length);
      bestVersion = version;
    }
  }
  return best;
}

// GET /models (every page). Same key header, timeout and error mapping as
// the other Gemini calls; the key never goes in the URL.
async function listGeminiModels(apiKey) {
  const models = [];
  let pageToken = '';
  for (let page = 0; page < HEADLINE_DISCOVERY_MAX_PAGES; page++) {
    const query = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) query.set('pageToken', pageToken);
    let res;
    try {
      res = await fetch(`${GEMINI_API_BASE}/models?${query.toString()}`, {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError('gemini', err);
    }
    if (!res.ok) throw httpError('gemini', res, await readProviderError(res));
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw aiError('PROVIDER_ERROR', 'Gemini sent back a model list Echo could not read.');
    }
    if (data && Array.isArray(data.models)) models.push(...data.models);
    pageToken = data && typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!pageToken) break;
  }
  return models;
}

// Starts the lookup if it hasn't run (or failed long enough ago). Never
// throws, never awaited by a headline request.
function discoverHeadlineModel() {
  const d = headlineDiscovery;
  if (d.status === 'pending' || d.status === 'done') return d.promise;
  if (d.status === 'failed' && Date.now() - d.failedAt < HEADLINE_DISCOVERY_RETRY_MS) return d.promise;
  const apiKey = keyStore.getKey('gemini');
  if (!apiKey) return null; // the request itself reports the missing key
  d.status = 'pending';
  d.promise = listGeminiModels(apiKey).then(
    (models) => {
      d.model = pickHeadlineModel(models);
      d.status = 'done';
      console.warn(d.model
        ? `[ai] First line will use ${d.model} (newest stable Flash-Lite).`
        : `[ai] No stable Gemini Flash-Lite model for this key -- the first line uses ${geminiModel()}.`);
    },
    (err) => {
      d.model = null;
      d.status = 'failed';
      d.failedAt = Date.now();
      console.warn(`[ai] Couldn't look up a Flash-Lite model for the first line (${(err && err.code) || 'error'}) -- using ${geminiModel()} for now.`);
    }
  );
  return d.promise;
}

// The model the next first line uses. discover=false: just report it
// (diagnostics), without starting the lookup.
function headlineModel({ discover = true } = {}) {
  const main = geminiModel();
  const override = (process.env.GEMINI_HEADLINE_MODEL || '').trim().replace(/^models\//, '');
  if (override) return MODEL_ID_RE.test(override) && !badHeadlineModels.has(override) ? override : main;
  if (discover) discoverHeadlineModel();
  const d = headlineDiscovery;
  return d.status === 'done' && d.model && !badHeadlineModels.has(d.model) ? d.model : main;
}

// Tests only: reset (or preset) the lookup state.
function resetHeadlineModel({ status = 'idle', model = null } = {}) {
  headlineDiscovery.status = status;
  headlineDiscovery.model = model;
  headlineDiscovery.failedAt = 0;
  headlineDiscovery.promise = null;
  badHeadlineModels.clear();
}

async function generateHeadline(params) {
  const {
    transcript, instruction, question, previousAnswers, images, knowledgeSnippets, signal, onChunk,
  } = params;
  const named = String(question || '').trim();
  const { mode, questionKind: kind, intent, allowNoResponse } = suggestionAnalysis(params);
  const filter = typeof onChunk === 'function' ? createStreamHumanizer() : null;
  const model = headlineModel();
  // Interview: the same state (trimmed) and the same Direction line as the full answer.
  const { block: stateBlock, direction } = interviewStateFor(mode, params.interviewState, { headline: true });
  const { block: briefBlock } = briefFor(mode, params.brief, { headline: true });
  // Same prompt, context, intent and kind whichever model writes it.
  const req = {
    systemPrompt: buildHeadlineSystemPrompt(mode),
    parts: buildUserParts(buildHeadlineConversation({
      transcript, previousAnswers, knowledgeSnippets, question: named, instruction, images, kind, mode, intent, allowNoResponse, stateBlock, direction, briefBlock,
      storyLine: storiesFor(mode, params.stories).line,
    }), images),
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
  };
  let result;
  try {
    result = await callGemini({ ...req, model });
  } catch (err) {
    // The first-line model is unknown to this key (retired, or a typo in
    // GEMINI_HEADLINE_MODEL): skip it for the rest of the run and use the
    // answer model. A 404 comes back before any text, so nothing was shown.
    const main = geminiModel();
    if (err.code !== 'MODEL_NOT_FOUND' || model === main || (signal && signal.aborted)) throw err;
    badHeadlineModels.add(model);
    console.warn(`[ai] First-line model ${model} isn't available -- using ${main} for the first line from now on.`);
    result = await callGemini({ ...req, model: main });
  }
  if (filter) {
    const rest = filter.end(); // e.g. a short reply the opener check was still holding
    if (rest) onChunk(rest);
  }
  return { text: firstSpokenSentence(humanizeAnswer(result.text)), questionKind: kind, intent };
}

async function askFollowUp({
  transcript, question, previousAnswers, images, knowledgeSnippets, mode, quality, brief, stories, signal, onChunk,
}) {
  const hasImages = !!(images && images.length);
  const kind = classifyQuestion(question, { hasImages, ...priorContext(previousAnswers) });
  const thinkingLevel = resolveThinkingLevel({ mode, quality, kind });
  const technical = kind === 'problem' || looksTechnical(question);
  // Interview mode: the same brief block as the answers ("what should I ask them?").
  const { block: briefBlock } = briefFor(normalizeMode(mode), brief);
  // Interview mode: a typed behavioural question gets the story bank too.
  const { block: storyBlock } = storiesFor(normalizeMode(mode), stories);
  const conversation = buildConversation({ transcript, previousAnswers, knowledgeSnippets, userQuestion: question, images, briefBlock, storyBlock });
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

// ---- Interview brief: job ad summary ----
// One small call when the user saves a long job ad (main.js), on the
// first-line model (Flash-Lite when available). Only the ad's own words:
// it must never add facts, so the prompt forbids anything not in the text.
const JOB_AD_SUMMARY_TIMEOUT_MS = 20_000;
const JOB_AD_SUMMARY_SYSTEM_PROMPT = `You condense a job ad for an interview co-pilot. Use ONLY what the ad itself says: never add facts about the company, the team or the role that aren't written in it, and never guess.
Write at most 5 short lines, plain text, no markdown, no intro, exactly these labels and skip any line the ad gives nothing for:
Role: the job title and level, and the team or product area if named.
Must-haves: the required skills, tools and experience, comma-separated.
Nice-to-haves: the preferred or bonus ones, comma-separated.
What they care about: values or ways of working the ad stresses, in a few words each.
Likely topics: what an interviewer for this ad would most likely ask about, using the ad's own wording.
Keep the whole thing under 600 characters.`;

function cleanJobAdSummary(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^[\s>*#-]+/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean);
  const joined = lines.join('\n');
  const max = interviewBrief.AD_SUMMARY_MAX_CHARS;
  return joined.length > max ? `${joined.slice(0, max - 1).trim()}…` : joined;
}

async function summarizeJobAd({ text, signal } = {}) {
  const ad = String(text || '').trim();
  if (!ad) return '';
  const req = {
    systemPrompt: JOB_AD_SUMMARY_SYSTEM_PROMPT,
    parts: [{ text: `JOB AD (pasted by the user):\n\n${ad.slice(0, interviewBrief.LIMITS.jobAd)}` }],
    thinkingLevel: 'low',
    answerTokens: 300,
    signal,
    timeoutMs: JOB_AD_SUMMARY_TIMEOUT_MS,
  };
  const model = headlineModel();
  let result;
  try {
    result = await callGemini({ ...req, model });
  } catch (err) {
    const main = geminiModel();
    if (err.code !== 'MODEL_NOT_FOUND' || model === main || (signal && signal.aborted)) throw err;
    result = await callGemini({ ...req, model: main });
  }
  return cleanJobAdSummary(result.text);
}

// ---- CV story bank: extraction ----
// One call per version of the knowledge files (story-store.js), on
// GEMINI_MODEL (quality matters more than speed here, and it runs in the
// background). Structured JSON; story-bank.js then checks every quote and
// number against the files before anything is kept.
const STORY_EXTRACT_TIMEOUT_MS = 90_000;
const STORY_EXTRACT_SYSTEM_PROMPT = `You build a story bank for a job candidate from their own files (CV, notes, project write-ups). A story is one concrete thing they did: a project, a job, a problem they solved, a team situation.
Rules:
- Use ONLY what the files say. Never add a detail, number, tool, result or feeling that isn't written there. If the files don't say the result, leave "result" empty.
- "quotes": 1 to 3 exact phrases copied character for character from the files that back the story up (each at least a few words). They are checked word for word; anything paraphrased is thrown away.
- "source": the file name the story comes from, exactly as in its "=== FILE: name ===" header.
- "title": a short name the candidate would use out loud ("the payments reconciliation service"), plain words.
- "situation", "action", "result": one or two short plain sentences each, in the first person, re-said in plain spoken words (not copied buzzwords), but with no fact that isn't in the files.
- "themes": the behavioural topics this story could answer, only from: THEME_LIST.
- "skills": the tools, languages and skills it shows, as named in the files.
Return 4 to 10 stories, the strongest and most distinct first. Fewer if the files don't have that many real stories; none rather than invented ones.
Then "drafts": story IDEAS for the user to confirm, for behavioural themes your stories above don't cover (especially conflict, failure, leadership, pressure, ambiguity). Look for a project detail that suggests one: a failover or retry feature suggests something broke; a bug that was fixed suggests a mistake caught; a team project suggests a disagreement about an approach; a deadline or a hackathon suggests pressure. For each:
- "basis": the exact phrase from the files it's built on (checked word for word).
- "idea": 2 or 3 short first-person lines the user could say if it happened, staying close to the basis. Never add numbers, names, tools or results that aren't in the files. The user will confirm it, fix it, or reject it, so make it easy to check: one concrete moment, not a polished story.
- "title", "source" and "themes" as for stories.
Return 0 to 8 drafts, one per theme at most, the most plausible first.`;

const STORY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    stories: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          source: { type: 'STRING' },
          situation: { type: 'STRING' },
          action: { type: 'STRING' },
          result: { type: 'STRING' },
          quotes: { type: 'ARRAY', items: { type: 'STRING' } },
          themes: { type: 'ARRAY', items: { type: 'STRING' } },
          skills: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['title', 'source', 'action', 'quotes', 'themes'],
      },
    },
    drafts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          source: { type: 'STRING' },
          basis: { type: 'STRING' },
          idea: { type: 'STRING' },
          themes: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['title', 'basis', 'idea', 'themes'],
      },
    },
  },
  required: ['stories'],
};

async function extractStories({ text, signal } = {}) {
  const input = String(text || '').trim();
  if (!input) return { stories: [] };
  const result = await callGemini({
    systemPrompt: STORY_EXTRACT_SYSTEM_PROMPT.replace('THEME_LIST', storyBank.THEMES.join(', ')),
    parts: [{ text: `THE CANDIDATE'S FILES:\n\n${input}` }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: STORY_SCHEMA },
    thinkingLevel: 'low',
    answerTokens: 6144, // stories + drafts
    signal,
    timeoutMs: STORY_EXTRACT_TIMEOUT_MS,
  });
  if (result.finishReason === 'MAX_TOKENS') throw aiError('TOO_LONG', 'The story bank was cut off (output limit).');
  try {
    return JSON.parse(result.text);
  } catch (err) {
    throw aiError('PROVIDER_ERROR', 'Gemini sent back a story bank Echo could not read.');
  }
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
  summarizeJobAd,
  invitesQuestions,
  extractStories,
  storiesFor,
  briefFor,
  testKeys,
  testOne,
  groqModel,
  geminiModel,
  headlineModel,
  pickHeadlineModel,
  discoverHeadlineModel,
  // Pure helpers, exported for main.js validation and the unit tests.
  QUALITY_SETTINGS,
  ANSWER_STYLES,
  normalizeAnswerStyle,
  MODES,
  normalizeMode,
  INTENTS: intentCore.INTENTS,
  NO_RESPONSE_SENTINEL,
  isNoResponse: intentCore.isNoResponse,
  analyzeSuggestion,
  buildSystemPrompt,
  MAX_PROMPT_TRANSCRIPT_CHARS,
  TRANSCRIPT_TRIMMED_MARKER,
  capTranscript,
  buildConversation,
  buildConversationText,
  buildUserParts,
  buildHeadlineSystemPrompt,
  buildHeadlineConversation,
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
  _resetHeadlineModel: resetHeadlineModel,
  _looksLikeHallucinatedSilence: looksLikeHallucinatedSilence,
  _generationConfigFor: generationConfigFor,
};
