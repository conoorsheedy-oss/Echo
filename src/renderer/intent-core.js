// Intent layer: what kind of thing did "Them" just say, and does the user
// need a suggestion for it? Rule-based (regexes, no API calls), pure, and
// shared by the renderer (auto-trigger) and main (prompt hints, the
// new-problem / follow-up classifier, the no-response sentinel). Loaded as a
// classic script after question-core.js (window.EchoIntentCore) and
// require()-able from main and the tests (test/intent-core.test.js).
//
// classifyIntent(text, ctx) -> { intent, confidence, needsResponse, technical }
//   intent        one of INTENTS (see detectIntent() for the patterns)
//   confidence    'high' when a specific phrase matched, 'low' for fallbacks
//   needsResponse should an AUTOMATIC suggestion fire? (explicit requests
//                 always answer and ignore it)
//   technical     code / maths / design talk (looksTechnical / classifyQuestion)
//
// needsResponse by mode:
//   interview     exactly question-core's looksLikeQuestion() -- the trigger
//                 behaviour from before the intent layer, unchanged.
//   meeting       any question-type intent, proposals and problems (the
//                 model may still decline with the NO_RESPONSE sentinel),
//                 and disagreement only when it plausibly answers the user
//                 (the user spoke in the last couple of lines / minute, or
//                 the line asks them directly).
//   presentation  question-type intents only (incl. explanation/clarification).
//   general       question-type intents and disagreement.
//   Never for "You" lines, information sharing or fillers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./question-core.js'));
  else root.EchoIntentCore = factory(root.EchoQuestionCore);
})(typeof self !== 'undefined' ? self : this, function (Question) {
  'use strict';

  const MODES = Object.freeze(['interview', 'meeting', 'presentation', 'general']);
  const INTENTS = Object.freeze([
    'direct_question', 'opinion_request', 'follow_up', 'disagreement', 'proposal',
    'suggestion_request', 'clarification_request', 'problem', 'information_sharing',
    'explanation_request', 'behavioural_question', 'technical_question', 'no_response',
  ]);
  const CONFIDENCES = Object.freeze(['high', 'low']);

  function normalizeMode(mode) {
    return typeof mode === 'string' && MODES.includes(mode) ? mode : 'general';
  }
  function isIntent(value) {
    return typeof value === 'string' && INTENTS.includes(value);
  }

  // ---- The "nothing to add" sentinel ----
  // Automatic suggestions outside interviews may answer with exactly this
  // when there's nothing worth saying. suggest-pipeline.js holds back the
  // start of every stream until it can tell, so it never reaches the screen.
  const NO_RESPONSE_SENTINEL = '[[NO_RESPONSE]]';
  const SENTINEL_FORMS = ['[[NO_RESPONSE]]', '[NO_RESPONSE]', 'NO_RESPONSE'];
  const SENTINEL_RE = /^\[{0,2}\s*no[_ ]response\b/i;
  const SENTINEL_LEAD_RE = /^[\s`"'*]+/;

  // 'yes' (the text starts with the sentinel), 'maybe' (too short to tell)
  // or 'no'. Leading spaces, quotes, backticks and ** are ignored.
  function sentinelState(text) {
    const t = String(text == null ? '' : text).replace(SENTINEL_LEAD_RE, '');
    if (!t) return 'maybe';
    if (SENTINEL_RE.test(t)) return 'yes';
    const upper = t.toUpperCase();
    return SENTINEL_FORMS.some((f) => f.startsWith(upper)) ? 'maybe' : 'no';
  }
  function isNoResponse(text) {
    return sentinelState(text) === 'yes';
  }

  // ---- Technical talk (moved here from ai.js; ai.js re-exports these) ----
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
    /\bhow (would|could|will|can|do) you (make|get) (it|this|that) (work|run|scale|handle|faster|fit)\b/i,
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
  // Also the words of a technical follow-up that don't look technical on
  // their own ("what is the complexity of that?", "any trade-offs?").
  const CODE_REFERENCE_RE = /\b(inputs?|outputs?|returns?|pairs?|elements?|values?|null|empty|duplicates?|negative|overflow|memory|loops?|index|indices|complexit(?:y|ies)|big[- ]?o|runtime|(?:edge|corner) cases?|trade-?offs?|test cases?|unit tests?|crash\w*|stream(?:s|ing)?|distributed|machines|scale|retr(?:y|ies|ied)|time ?outs?|concurren\w*|at the same time|simultaneous\w*|idempoten\w*|race conditions?|requests?|servers?|databases?|cache|fail(?:s|ed|ure)?|goes down|keys?|(your|the|this|that)( current)? (code|solution|approach|function|implementation|algorithm|method))\b/i;
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

  // ---- Intent patterns ----
  // Matched against the line with straight apostrophes, case-insensitive,
  // anywhere in the line on word boundaries (people bury the ask: "Sarah
  // what do you think", "honestly I don't think that'll work"). Only the
  // soft follow-ups ("go on", "such as?") need a clause start.
  const CS = String.raw`(?:^|[.!?,;:]\s*|\b(?:and|so|but|then|okay|ok|right|alright|yeah|well|now|also|honestly|actually|sorry|look|i mean|um|uh)\s+)`;
  const re = (body) => new RegExp(String.raw`\b(?:${body})`, 'i');
  const atClause = (body) => new RegExp(`${CS}(?:${body})`, 'i');

  // A whole line of acknowledgements / fillers ("okay", "yeah sounds good",
  // "mm-hmm", "right?", "thanks").
  const ACK_WORD = String.raw`(?:ok(?:ay)?|k|yeah|yep|yes|yup|sure|right|cool|great|nice|perfect|awesome|good|fine|alright|all right|got it|gotcha|i see|i get it|understood|makes sense|that makes sense|fair enough|fair|true|exactly|totally|definitely|absolutely|of course|interesting|h?m+|mhm+|mm-hmm|uh-huh|uh|um|erm|er|oh|ah|wow|no worries|no problem|sounds good|sounds great|that sounds good|thanks|thank you|thanks so much|thank you so much|cheers|appreciate it|nice one|will do|you know|i know|go on|sure thing|let's see|so|anyway|and|but|well|like)`;
  // Words must be separated (so the match can't split "mmmm" many ways).
  const ACK_ONLY_RE = new RegExp(String.raw`^${ACK_WORD}(?:[\s,.!?…-]+${ACK_WORD})*[\s,.!?…-]*$`, 'i');

  const BEHAVIOURAL_RE = re(String.raw`tell me about (?:a|an|the) (?:time|situation|occasion|moment|project you|example|challenge|conflict|failure|mistake)|tell me about yourself|describe (?:a|an) (?:time|situation|occasion|moment)|give me (?:an )?example of (?:a time|when|how you)|(?:can|could) you think of (?:a|an) (?:time|example|situation)|have you ever (?:had|been|faced|dealt|disagreed|failed|made|worked|led|handled)|how do you (?:handle|deal with|cope with|manage|respond to|approach) (?:conflict|stress|pressure|feedback|criticism|disagreements?|deadlines|failure|ambiguity|difficult|competing|setbacks|tight|a difficult|change)|(?:what(?:'s| is| are|'re) )?your (?:greatest|biggest) (?:weakness|weaknesses|strength|strengths|achievement|accomplishment|challenge|failure|mistake)|(?:greatest|biggest) (?:weakness|strength)|your (?:weaknesses|strengths)|why do you want (?:to|this)|why (?:should we hire|are you interested|this (?:company|role|job|team))|where do you see yourself|walk me through your (?:resume|cv|background|career)|what motivates you|why (?:are you leaving|did you leave)`);

  const CLARIFY_RE = re(String.raw`what do you mean|what did you mean|what (?:exactly )?do you mean by|(?:can|could) you clarify|clarify what you|(?:can|could) you explain what you meant|what you meant|(?:did|do) you say|what did you say|(?:can|could) you (?:repeat|say) (?:that|the question|it)|say that again|come again|i didn't (?:catch|get|follow) (?:that|you|what)|i'm not sure what you mean|i don't follow|meaning what|what was that`);

  const DISAGREE_RE = re(String.raw`i don't think (?:that|this|it|so|we should|that's|this is|it's|that'll|this'll|it'll|it will|that will|that would|it would)|i don't agree|i disagree|i'd disagree|i don't buy|i'm not (?:so )?(?:sure|convinced) (?:about|that|this|it|if that|we should|that's)|i'm not convinced|not convinced|that (?:won't|wouldn't) (?:work|scale|fly|help|hold|be enough|solve|fix)|that (?:doesn't|isn't going to|is not going to|will not|can't) (?:work|scale|fly|hold|happen)|the (?:problem|issue|trouble|risk|catch) with (?:that|this|it|your|doing|going)|but what about|i'd push back|i'm going to push back|let me push back|i want to push back|push back on|that's not (?:true|right|correct|how|what)|i'm (?:a bit |a little |pretty )?skeptical|i have (?:some |a few |real )?(?:concerns|doubts)|i see it differently|i'm not so sure|that's a bad idea|i don't (?:like|love) (?:that|this|the idea)|i'm not sold|i'm against|i wouldn't (?:do|go with|recommend)|that seems (?:risky|wrong|like a bad)|respectfully`);

  const OPINION_RE = re(String.raw`what do you think|what are your thoughts|what's your (?:take|view|opinion|read|feeling|gut|sense|position|stance)|what is your (?:take|view|opinion)|your take on|thoughts on|any thoughts|thoughts\?|how do you feel about|how do you see|would you agree|do you agree|do you think|don't you think|would you say|what would you do|are you (?:for|okay with|ok with|on board|happy with|comfortable with)|which (?:one )?(?:do you|would you) (?:prefer|pick|choose|go with)|do you prefer|is that (?:a good|the right) idea|should we\b`);

  const SUGGEST_RE = re(String.raw`any (?:other )?(?:ideas|suggestions|recommendations|advice|options)|what would you (?:suggest|recommend|advise|propose)|what do you (?:suggest|recommend|propose|advise)|how should we|what should we (?:do|try|use|go with|prioriti[sz]e)|where should we (?:start|begin|go|focus)|what do we do (?:about|now|next|here)|how do we (?:fix|solve|handle|deal|get|move|approach|tackle|unblock)|what's the best way to|how can we (?:fix|improve|speed|reduce|get|make|solve|avoid)|what are our options|open to (?:ideas|suggestions)|ideas welcome|how would you (?:approach|tackle|go about)|what would you change`);

  const EXPLAIN_RE = re(String.raw`(?:can|could|would) you (?:please )?(?:explain|elaborate|walk (?:me|us) through|talk (?:me|us) through|go over|break down)|explain (?:how|why|what|the|this|that|it|your|to)|walk (?:me|us) through|talk (?:me|us) through|take (?:me|us) through|run (?:me|us) through|how (?:does|do|did) (?:it|this|that|the|your|a|an)\b.{0,60}\bwork|what's the difference between|what is the difference between|help me understand|elaborate on`);

  // "Tell me more", "how so", "why is that": only a follow-up when there's
  // something to follow (an earlier answer, or the user just spoke).
  const SOFT_FOLLOWUP_RE = atClause(String.raw`tell me more|(?:can|could) you (?:expand|say more|go deeper|be more specific)|say more|go on\b|how so|why is that|why's that|and then what|what happened (?:next|then|after)|what did you do (?:next|then|after)|such as\??$|like what\??$|for example\??$|what else`);

  const PROPOSAL_RE = re(String.raw`what if we|how about (?:we|using|trying|moving|switching|going|doing|adding|dropping)|what about (?:we|using|trying|moving|switching|going|doing)|i (?:suggest|propose|recommend)|i'd (?:suggest|propose|recommend)|my (?:suggestion|proposal|recommendation|idea) (?:is|would be)|(?:maybe|perhaps) we (?:should|could|can|just)|i think we (?:should|need to|could)|i'd (?:like to|rather) (?:go with|use|try|move|switch)|why don't we|we should (?:probably |just |really )?(?!have\b)|one option is|another option is|the other option is|i was thinking (?:we|that we|maybe)|it might be (?:worth|better)|could we (?:try|just|maybe|use|move)`);
  // "let's ..." is a proposal, except set-ups and agenda talk.
  const LETS_RE = re(String.raw`let's (?!say\b|assume\b|imagine\b|pretend\b|suppose\b|move on\b|get started\b|start\b|begin\b|wrap\b|take a\b|circle back\b|recap\b|talk about\b|go through\b|look at\b|discuss\b|jump\b|dive\b|kick off\b|continue\b|see\b|go to\b|hear\b|hop\b|get going\b)|we (?:could|can) (?:just |also |always )?(?:try|use|move|switch|go|add|drop|split|cut|ship|push|delay|start|build|do)`);

  const PROBLEM_RE = re(String.raw`we're (?:blocked|stuck)|(?:i'm|we're|they're|it's) blocked|blocked on|blocker|the (?:main |big |real )?(?:issue|problem|bug|challenge) (?:is|right now|here|we have|we're having)|keeps (?:failing|crashing|breaking|timing out|going down|throwing)|(?:is|are|has been|have been|it's|keep|kept) (?:failing|broken|crashing|flaky|timing out)|(?:site|server|service|prod|production|api|app|build|database|db|staging|pipeline|ci) (?:is|went|has been) down|(?:doesn't|isn't|won't|don't|aren't|still not) work(?:ing)?|not working|we have (?:a|an|some|a big|a real) (?:problem|issue|bug|outage|incident)|there's (?:a|an) (?:problem|issue|bug|outage|incident)|we're (?:behind|running behind|over budget|running out)|we're out of|missed the deadline|we can't figure out|not sure how to (?:fix|solve)|(?:we're|i'm) struggling|getting an? (?:error|exception)|throws an? (?:error|exception)|we lost (?:a|the|our)`);

  const INFO_RE = re(String.raw`fyi|for your information|just so (?:you|everyone) knows?|heads up|quick update|just an update|to give (?:you|everyone) an update|update on|announcement|we (?:shipped|released|launched|finished|closed|signed|hired|merged|deployed)|i (?:finished|shipped|sent|updated|merged|deployed|talked to|spoke to)`);

  // Directly asks the user (a disagreement that ends "...do you?" etc.).
  const ASKS_YOU_RE = /\b(?:you|your)\b[^.!?]*\?|\?[^?]*$/i;

  const QUESTION_INTENTS = new Set([
    'direct_question', 'opinion_request', 'suggestion_request', 'clarification_request',
    'explanation_request', 'behavioural_question', 'technical_question', 'follow_up',
  ]);

  function normalizeText(text) {
    return String(text == null ? '' : text).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
  }

  // recentYou: { themLinesSince, msSince } -- how many "Them" lines (this
  // one included) since the user last spoke, and how long ago. Missing
  // msSince counts as recent enough (main has no timestamps).
  const RECENT_THEM_LINES = 2;
  const RECENT_YOU_MS = 60_000;
  function userSpokeRecently(recentYou) {
    if (!recentYou || typeof recentYou !== 'object') return false;
    const lines = Number(recentYou.themLinesSince);
    if (!Number.isFinite(lines) || lines < 0 || lines > RECENT_THEM_LINES) return false;
    const ms = Number(recentYou.msSince);
    return !Number.isFinite(ms) || ms <= RECENT_YOU_MS;
  }

  // Just the label: { intent, confidence, technical, asks }.
  function detectIntent(text, ctx = {}) {
    const raw = normalizeText(text);
    const prior = ctx.prior || {};
    if (!raw) return { intent: 'no_response', confidence: 'high', technical: false, asks: false };
    // On the text as given (not normalised), so interview mode triggers on
    // exactly what question-core always triggered on.
    const asks = Question.looksLikeQuestion(text);
    const kind = classifyQuestion(raw, { hasPriorAnswer: !!prior.hasPriorAnswer, priorCode: !!prior.lastAnswerTechnical });
    const technical = looksTechnical(raw) || kind === 'problem' || (!!ctx.hasImages && asks);
    const out = (intent, confidence) => ({ intent, confidence, technical, asks });
    const words = wordCount(raw);

    if (ACK_ONLY_RE.test(raw)) return out('no_response', 'high');
    if (BEHAVIOURAL_RE.test(raw)) return out('behavioural_question', 'high');
    if (CLARIFY_RE.test(raw)) return out('clarification_request', 'high');
    if (DISAGREE_RE.test(raw)) return out('disagreement', 'high');
    if (SUGGEST_RE.test(raw)) return out('suggestion_request', 'high');
    if (OPINION_RE.test(raw)) return out('opinion_request', 'high');
    if (kind === 'problem') return out('technical_question', 'high');
    if (kind === 'followup' && prior.hasPriorAnswer && prior.lastAnswerTechnical) return out('follow_up', 'high');
    if (SOFT_FOLLOWUP_RE.test(raw) && (prior.hasPriorAnswer || userSpokeRecently(ctx.recentYou))) return out('follow_up', 'low');
    if (EXPLAIN_RE.test(raw)) return out('explanation_request', 'high');
    if (PROPOSAL_RE.test(raw)) return out('proposal', 'high');
    if (PROBLEM_RE.test(raw)) return out('problem', asks ? 'low' : 'high');
    if (LETS_RE.test(raw)) return out('proposal', 'low');
    if (asks) {
      if (technical) return out('technical_question', 'low');
      return out('direct_question', /\?/.test(raw) ? 'high' : 'low');
    }
    if (INFO_RE.test(raw)) return out('information_sharing', 'high');
    if (words < 3) return out('no_response', 'low');
    return out('information_sharing', 'low');
  }

  function needsResponseFor(mode, label, raw, ctx) {
    if (mode === 'interview') return label.asks; // unchanged: question-core's rule
    const { intent } = label;
    if (QUESTION_INTENTS.has(intent)) return true;
    if (intent === 'disagreement') {
      if (mode === 'general') return true;
      if (mode !== 'meeting') return false;
      return userSpokeRecently(ctx.recentYou) || OPINION_RE.test(raw) || ASKS_YOU_RE.test(raw);
    }
    if (mode === 'meeting') return intent === 'proposal' || intent === 'problem';
    return false;
  }

  // ctx: { mode, speaker: 'them' | 'you', prior: { hasPriorAnswer,
  // lastAnswerTechnical }, recentYou: { themLinesSince, msSince },
  // hasImages }. lastYouLine (an alias kept for callers that pass the
  // user's last line with its age) is folded into recentYou.
  function classifyIntent(text, ctx = {}) {
    const c = { ...ctx };
    if (!c.recentYou && c.lastYouLine && typeof c.lastYouLine === 'object') c.recentYou = c.lastYouLine;
    const mode = normalizeMode(c.mode);
    const raw = normalizeText(text);
    const label = detectIntent(text, c);
    const speaker = String(c.speaker || 'them').toLowerCase();
    const needsResponse = speaker === 'them' && needsResponseFor(mode, label, raw, c);
    return { intent: label.intent, confidence: label.confidence, needsResponse, technical: label.technical };
  }

  // The renderer's gate: only "Them" lines, only when the intent needs one.
  function shouldAutoTrigger(intentResult, { mode, speaker } = {}) {
    void mode; // needsResponse is already mode-specific
    if (String(speaker || '').toLowerCase() !== 'them') return false;
    return !!(intentResult && intentResult.needsResponse);
  }

  return Object.freeze({
    MODES,
    INTENTS,
    CONFIDENCES,
    NO_RESPONSE_SENTINEL,
    normalizeMode,
    isIntent,
    sentinelState,
    isNoResponse,
    TECHNICAL_PATTERNS,
    looksTechnical,
    classifyQuestion,
    wordCount,
    detectIntent,
    classifyIntent,
    shouldAutoTrigger,
    userSpokeRecently,
  });
});
