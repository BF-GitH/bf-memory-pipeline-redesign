import { injectMemoryContext } from './agent-writer.js';
import { runMemoryAgent, isConnectionFailure } from './agent-memory.js';
import { runReflection } from './agent-reflect.js';
import { runLookupAgent, renderLookupBlock, LOOKUP_TIMEOUT_MS, LOOKUP_TIMEOUT_STRIKES, LOOKUP_DEADLINE_GRACE_MS } from './agent-lookup.js';
import { cancelInFlightLLM, callAgentLLM } from './llm-call.js';
import { extractSentenceLine, countSentenceEnds } from './sentence-util.js';
import { recordHealthEvent, clearHealthEvents } from './health.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, saveCurrentToActiveProfile, setRunTokens, setMainOutputTokens, addAgent3Tokens, addReflectionTokens, getReflection, getMemorySheet, setMemorySheet, getStorySpine, appendStorySpineBatch, beginRun, endRun, setPendingRun, getPendingRun, consumePendingRun, isTriviallyEmptyForExtraction } from './settings.js';
// Straight from the module that owns them: settings.js re-exports the older
// turn-state surface this file already used, but not these.
import { bumpReflectionProgress, resetReflectionProgress, extractSheetFactRefs } from './turn-state.js';
import { recordFactUsage } from './database.js';

let internalCallDepth = 0;
const isInternalCall = () => internalCallDepth > 0;
let pipelineJustInjected = false; 
let injectedResetTimer = null; 
let pipelineCancelled = false; 
let groupSkipToastShown = false; 
let runRecordedInput = false; 

// NOTE: the "successful runs since the last reflection pass" counter is NOT
// here. It lived at module scope and was zeroed on CHAT_CHANGED, so a user who
// switched or reloaded chats more often than REFLECTION_INTERVAL runs never
// reached the interval and got no reflection at all. It is now chat-scoped
// state in turn-state.js (bumpReflectionProgress / resetReflectionProgress),
// persisted in chatMetadata as bf_mem_reflect_progress.
let reflectionPending = null;
let reflectionInFlight = false;
// Abort handle for the reflection pass that is currently running (null when
// none is). Reflection is the longest pass in the system — up to 7 rounds
// against a 10-minute tool-loop budget — and it now MUTATES the fact store, so
// it must be interruptible by the same events that already void pipeline work.
//
// This is NOT a second cancellation mechanism. cancelInFlightLLM already aborts
// the network leg in flight, but it then CLEARS its controller set, so the tool
// loop would just open a fresh leg on the next round and keep writing. The
// signal is what makes the LOOP stop: callAgentLLMWithTools re-checks it before
// every round and between every tool call, so the abort survives across rounds
// and lands even when it arrives while tools (not the LLM) are executing.
let reflectionAbort = null;

// --- Story evidence for the reflection pass --------------------------------
// Reflection used to see the fact digest, the beat list and its own prior
// recap — memory only. It could compare memory against MEMORY but never memory
// against the STORY, so a stored value the narrative has been contradicting for
// thirty messages was structurally invisible to it: the contradiction scan
// needs TWO stored facts, and the extractor's overwrite-in-place rule
// guarantees the second one never exists. Hence the raw recent messages, handed
// over as evidence to check the digest against.
//
// WINDOW SIZE. Reflection fires on a CADENCE — REFLECTION_INTERVAL (12)
// successful extraction runs, and a run settles roughly one exchange, so a pass
// lands about every ~24 messages. A fixed 20-message window would therefore
// leave a permanent unread gap between consecutive passes and keep missing the
// same stretch of story forever. So the window is "everything since the
// previous pass" (lastReflectionChatIndex), which is cheap — one integer, no
// scan — and by construction cannot skip a stretch. It is floored at
// REFLECT_STORY_MIN_MESSAGES so the first pass in a chat, or a pass fired
// unusually early, still gets enough narrative to judge anything at all, and
// capped at REFLECT_STORY_MAX_MESSAGES so a long catch-up backlog (or a chat
// switched back into after hundreds of messages) cannot hand one pass the
// entire history.
const REFLECT_STORY_MIN_MESSAGES = 20;
const REFLECT_STORY_MAX_MESSAGES = 60;
// Message COUNT says nothing about size, and this is raw prose going straight
// into the reflection prompt — a handful of 4 KB replies would blow the call up
// on its own. Cap the total characters as well, dropping OLDEST-first: the
// newest messages are the ones most likely to contradict a stored fact.
const REFLECT_STORY_MAX_CHARS = 12000;
// Chat index of the newest message the PREVIOUS reflection pass was given.
// -1 = no pass yet in this chat. Chat-scoped: reset on CHAT_CHANGED.
let lastReflectionChatIndex = -1;

let memoryExtractionInFlight = false;

let extractionRetryAfterBusy = false;
let cancelledRetryArmed = false;

// Timeout auto-retry (single-flight): a connection-class extraction failure
// (timeout/abort/network/fetch — never a protocol error) schedules ONE
// automatic retry after 20s instead of waiting for the next user message. A
// SECOND consecutive connection failure parks the backlog until the next
// message (the per-message watermarks make waiting safe). User-cancelled runs
// never auto-retry, and a genuine run always supersedes a pending auto-retry.
const CONNECTION_RETRY_DELAY_MS = 20000;
let connectionRetryTimer = null;
let connectionFailureStreak = 0;

// Post-injection proof for the Health tab's "Copy last prompt" button: the FULL
// message array of the last generation AS SENT (after trim + sheet injection).
// Session-only, capped at ~2 MB serialized, cleared on chat switch. External
// capture tools (e.g. bf-cache-verify) hook the same event BEFORE this
// extension's injection and therefore show a prompt WITHOUT sheet/trim — this
// snapshot is the ground truth taken AFTER.
const LAST_PROMPT_CAP_CHARS = 2 * 1024 * 1024;
let lastSentPrompt = null; // { ts, path, messages: [{ role, text }] }

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // Multimodal parts: keep the text pieces, drop binary payloads.
        return content.map(p => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('\n');
    }
    return String(content ?? '');
}

function capturePostInjectionPrompt(arr, path, promptString = null) {
    try {
        let messages;
        if (Array.isArray(arr)) {
            messages = arr.map(m => ({ role: String(m?.role || ''), text: contentToText(m?.content) }));
        } else if (typeof promptString === 'string') {
            // Text-completion string prompt: one pseudo-message carries it all.
            messages = [{ role: 'prompt', text: promptString }];
        } else {
            return;
        }
        // Cap at ~2 MB serialized: drop the OLDEST messages first — the newest
        // carry the injected sheet and the actual exchange, which is the proof.
        let total = JSON.stringify(messages).length;
        while (messages.length > 1 && total > LAST_PROMPT_CAP_CHARS) {
            total -= JSON.stringify(messages[0]).length + 1;
            messages.shift();
        }
        if (messages.length === 1 && total > LAST_PROMPT_CAP_CHARS) {
            messages[0] = { role: messages[0].role, text: messages[0].text.slice(0, LAST_PROMPT_CAP_CHARS) };
        }
        lastSentPrompt = { ts: Date.now(), path, messages };
    } catch {  }
}

export function getLastSentPrompt() {
    return lastSentPrompt;
}

// --- Usage accounting for the facts that actually reached the model ---------
//
// useCount / lastUsedAt are read by salienceScore() and effectiveRecencyTs()
// (database.js) and decide which facts survive cold-tiering. Nothing ever wrote
// them: in the analysed session all 64 facts sat at 0/0, so a fact injected on
// every single turn cooled out at exactly the rate of one never injected at all.
// recordFactUsage() is the write side; this is the caller.
//
// WHAT COUNTS. Only what was really sent. The refs come from the sheet TEXT that
// went into the prompt, not from the agent's NEED selection: the sheet is the
// only record that INCLUDES the premise-floor rows and the random-walk extras
// and EXCLUDES refs composeSheet resolved away as cold/inactive/invisible. A
// candidate that was considered and dropped never appears in it.
//
// WHEN. Armed (two cheap property reads, no parsing) by whichever injection
// handler fired, flushed once from MESSAGE_RECEIVED — i.e. after the prompt has
// gone out AND the reply has landed. That is the one point true for BOTH the
// chat-completion and the text-completion path, it adds nothing to prompt
// building, and it batches the whole sheet into one call. A generation the user
// stops never reaches the flush; the record is simply superseded by the next
// injection, so THAT case undercounts. It is the only one this arm/flush shape
// handles on its own — the swipe case below is not, and used to double count.
//
// ONCE PER TURN, NOT PER GENERATION. A swipe or a regenerate re-enters the
// injection handler with the SAME user message and lands another MESSAGE_RECEIVED
// (the same property the extraction re-run relies on — see the comment above
// runMemoryExtraction), so an unguarded flush credited three swipes of one turn as
// three uses of every row on that sheet. This counter feeds cold-tiering, so that
// inflation lands on exactly the signal it was added to measure. lastCountedTurn
// is the guard: the second and later generations of the same turn are recorded as
// skipped, not counted.
//
// TURN IDENTITY is the newest genuine user message: its chat index AND a prefix of
// its text. The index alone is not enough (deleting a message shifts every later
// one, so a stale index would silently swallow a real turn); the text alone is not
// enough (a user may legitimately send the same words twice). Together they
// collide only for "the same words at the same index in the same chat", which is
// the same turn under any reading. Before the first user message the key is
// stable and empty, which correctly treats greeting rerolls as one turn.
//
// The captured TEXT is held, not the sheet record: strings are immutable, so a
// setMemorySheet() landing between injection and flush cannot retro-change what
// this turn is credited with.
let pendingFactUsage = null; // { text, chatId, charAvatar, path, at, turnKey }
let lastCountedTurn = null;  // `${chatId}|${avatar}|${turnKey}` of the last flush that counted

function newestUserTurnKey() {
    try {
        const chat = SillyTavern.getContext()?.chat;
        if (!Array.isArray(chat)) return '';
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (isGenuineMessage(m) && m.is_user) return `${i}:${String(m.mes || '').slice(0, 200)}`;
        }
    } catch {  }
    return '';
}

function armFactUsage(sheetText, path) {
    try {
        const ctx = SillyTavern.getContext();
        pendingFactUsage = {
            text: String(sheetText || ''),
            chatId: String(ctx.getCurrentChatId?.() || ctx.chatId || ''),
            charAvatar: ctx.characters?.[ctx.characterId]?.avatar || '',
            path,
            at: Date.now(),
            // Read at ARM time, not at flush time: by the time MESSAGE_RECEIVED
            // fires the reply has been pushed onto ctx.chat, but the newest USER
            // message is the same one either way — capturing it here keeps the key
            // tied to the prompt this record is about.
            turnKey: newestUserTurnKey(),
        };
    } catch { pendingFactUsage = null; }
}

// Non-fatal by construction: recordFactUsage never throws and never rejects, and
// everything around it is wrapped. A failure here can never block a generation —
// the generation is already finished by the time this runs.
async function flushInjectedFactUsage() {
    const pending = pendingFactUsage;
    pendingFactUsage = null;
    if (!pending) return;
    try {
        // recordFactUsage resolves refs against the LIVE character's store, so a
        // switch between injection and flush would bump the wrong character's
        // facts. Same captured-vs-live pair the extraction commit gate uses.
        const ctx = SillyTavern.getContext();
        const liveChatId = String(ctx.getCurrentChatId?.() || ctx.chatId || '');
        const liveAvatar = ctx.characters?.[ctx.characterId]?.avatar || '';
        if (liveAvatar !== pending.charAvatar || (pending.chatId && liveChatId && liveChatId !== pending.chatId)) {
            addDebugLog('info', `Fact usage not recorded — character or chat changed since injection (${pending.charAvatar}/${pending.chatId} -> ${liveAvatar}/${liveChatId})`, {
                subsystem: 'db', event: 'fact.used', reason: 'CONTEXT_CHANGED',
            });
            return;
        }

        // A catch-up import rebuilds the whole store; bumping counters against a
        // cache it is about to replace wholesale is at best pointless. One turn
        // of usage dropped during an import costs nothing — the record is not
        // deferred, it is discarded.
        try {
            const { isCatchupRunning } = await import('./catchup-import.js');
            if (isCatchupRunning()) {
                addDebugLog('info', 'Fact usage not recorded — catch-up import in progress (store is being rebuilt)', {
                    subsystem: 'db', event: 'fact.used', reason: 'CATCHUP_RUNNING',
                });
                return;
            }
        } catch {  }

        // Per-TURN, not per generation. Checked after the context and catch-up
        // gates and before the ref parse, so a swipe costs one string compare.
        const turnId = `${pending.chatId}|${pending.charAvatar}|${pending.turnKey}`;
        if (lastCountedTurn === turnId) {
            addDebugLog('debug', 'Fact usage not recorded — this turn was already counted (swipe/regenerate of the same user message)', {
                subsystem: 'db', event: 'fact.used', reason: 'TURN_ALREADY_COUNTED',
                data: { path: pending.path },
            });
            return;
        }

        const refs = extractSheetFactRefs(pending.text);
        if (refs.length === 0) return; // seed sheet, or a sheet with no fact rows
        // Latched only once the write is committed: a failed record must not lock
        // the turn out of being counted by the swipe that follows it.
        await recordFactUsage(refs, { at: pending.at, reason: 'SHEET_INJECTED' });
        lastCountedTurn = turnId;
    } catch (err) {
        addDebugLog('fail', `Fact usage recording failed (non-fatal): ${err?.message || err}`, {
            subsystem: 'db', event: 'fact.used', reason: 'FLUSH_FAILED',
        });
    }
}

// --- The LOOKUP pass — the one thing that runs BEFORE the storyteller -------
//
// THE HOOK, and why it is these two. The pass needs three things at once: the
// user's message must EXIST, the prompt must not have gone out yet, and the
// sheet text about to be injected must be in hand. Both injection handlers below
// satisfy all three, they are the only points in this file that do, and ST
// AWAITS both — so an await here genuinely holds the request, which is what makes
// a deadline meaningful. They are also mutually exclusive per generation
// (CHAT_COMPLETION_PROMPT_READY fires for chat-completion APIs;
// GENERATE_AFTER_DATA returns early when mainApi === 'openai'), so one shared
// helper called from both runs exactly once per turn.
//
// Rejected alternatives, both for the same reason — they buy overlap and pay in
// correctness: MESSAGE_SENT fires earlier (the lookup could overlap ST's own
// prompt building) but never fires for swipe / regenerate / continue, so the
// feature would silently not exist for a third of generations;
// GENERATION_AFTER_COMMANDS fires before sendMessageAsUser has pushed the user
// message into ctx.chat, i.e. before the one input this pass is built around.
//
// The block is appended to the sheet TEXT rather than injected separately, so it
// rides the sheet's own placement (prepended to the newest user message, depth 1)
// and needs no second injection point. It is rendered with buildFactLine, so
// extractSheetFactRefs sees its rows and flushInjectedFactUsage credits them like
// any other injected row — which is correct: they were injected.
let lookupAbort = null;
// Consecutive deadline strikes, and the session latch they arm. A misconfigured
// profile otherwise costs LOOKUP_TIMEOUT_MS of dead latency on every single
// message; bounded per turn is not the same as bounded overall. Reset by a chat
// switch and by toggling the setting (resetLookupBreaker).
let lookupTimeoutStrikes = 0;
let lookupOffForSession = false;
// The last ref set, keyed by the exact message it was found for. A swipe or a
// regenerate re-enters this handler with the SAME user message; re-running the
// pass would spend the latency twice for an answer that cannot differ. Refs are
// cached, not the rendered block — the sheet may have been recomposed since, and
// the "already on the sheet" exclusion has to be redone against the sheet that is
// actually going out.
let lastLookup = null; // { chatId, avatar, message, refs }
let lookupSeq = 0;

// The type ST passed to Generate() for the generation currently being built, or
// null when none has been seen. Latched on GENERATION_STARTED and CONSUMED by
// whichever injection handler fires next.
//
// WHY A LATCH. Both injection handlers also fire for generateQuietPrompt traffic —
// ST's auto-summarize, the image-caption prompt, /gen, and any other extension's
// background generation — and neither payload says so. The lookup must not run for
// those: newestUserExchange() would return the last CHAT user message, which has
// nothing to do with the quiet prompt, and the pass would then hold a background
// job for up to the deadline plus an LLM call to answer a question nobody asked.
//
// CONSUMED, not just overwritten, and the untouched value is null = "assume
// genuine". Both directions are deliberate: the handlers are mutually exclusive
// and fire exactly once per generation, so consuming means a stale 'quiet' can
// never outlive the generation that set it, and defaulting to genuine means a
// generation path that somehow skips GENERATION_STARTED loses nothing.
let lastGenerationType = null;

function consumeGenerationType() {
    const t = lastGenerationType;
    lastGenerationType = null;
    return t;
}

// Backstop sentinel — a distinct object for the same reason DEADLINE/ABORTED are
// in agent-lookup.js: it must not be confusable with a sheet string.
const LOOKUP_BACKSTOP = { __lookup: 'backstop' };

// Re-arms the session latch. Called from CHAT_CHANGED and from the settings
// checkbox — a user who changes the profile after three timeouts is entitled to
// have it try again without reloading.
export function resetLookupBreaker() {
    lookupTimeoutStrikes = 0;
    lookupOffForSession = false;
    lastLookup = null;
}

function abortLookupPass(reason) {
    const ctrl = lookupAbort;
    if (!ctrl || ctrl.signal.aborted) return;
    try { ctrl.abort(new DOMException(`BF Memory lookup cancelled (${reason})`, 'AbortError')); } catch {  }
}

// The newest genuine user message and the reply it answers. ctx.chat is used
// rather than the prompt payload because the two injection handlers receive
// structurally different payloads and this must be the same input on both.
function newestUserExchange() {
    const out = { message: '', prior: '' };
    try {
        const chat = SillyTavern.getContext()?.chat;
        if (!Array.isArray(chat)) return out;
        let i = chat.length - 1;
        for (; i >= 0; i--) {
            const m = chat[i];
            if (isGenuineMessage(m) && m.is_user) { out.message = String(m.mes || ''); break; }
        }
        for (let j = i - 1; j >= 0; j--) {
            const m = chat[j];
            if (isGenuineMessage(m) && !m.is_user) { out.prior = String(m.mes || ''); break; }
        }
    } catch {  }
    return out;
}

// Returns the sheet text to inject — the original one on every skip, error and
// timeout path. NEVER throws: the caller is a generation handler.
//
// THIS FUNCTION IS THE DEADLINE'S ENFORCEMENT POINT, and it is the only one that
// can be. Everything the injection handler awaits is awaited here, so the bound
// has to be applied here rather than inside any single stage: the pass body is
// raced, as ONE unit, against a timer armed before its first await. Worst case for
// the user is therefore LOOKUP_TIMEOUT_MS + LOOKUP_DEADLINE_GRACE_MS from entry,
// whatever is slow and however many awaits the body grows later.
//
// The per-stage deadlines inside runLookupAgent/renderLookupBlock share the SAME
// absolute timestamp and so always fire first; they are what abort the in-flight
// leg and name which stage was slow. The race below is the backstop for an await
// that no per-stage race covers — today the dynamic import of catchup-import.js,
// tomorrow whatever gets added — and it firing is a distinct, logged condition.
async function appendLookupBlock(sheetText, path, genType) {
    const settings = getSettings();
    if (!settings?.lookupEnabled || lookupOffForSession) return sheetText;
    // A generation the user already stopped (or a disabled pipeline — both set
    // this) must not spend an LLM call, let alone hold anything up.
    if (pipelineCancelled) return sheetText;
    // Not the storyteller answering the user. 'quiet' is generateQuietPrompt —
    // auto-summarize, image captions, /gen, other extensions' background work;
    // 'impersonate' is the model writing the USER's next message, so the newest
    // user message this pass is built around is not the thing being answered
    // either. Both would pay the full latency for a lookup nobody reads.
    if (genType === 'quiet' || genType === 'impersonate') {
        addDebugLog('debug', `Lookup skipped — ${genType} generation, not a storyteller reply to the user`, {
            subsystem: 'agent3', event: 'lookup.skip', reason: 'NOT_A_USER_TURN',
            data: { path, genType },
        });
        return sheetText;
    }
    // RE-ENTRANCY, on the mechanism the extraction path already uses rather than a
    // second one: the pass raises internalCallDepth for its whole duration, so a
    // generation raised from inside it (the lookup's own LLM call, if it ever
    // stopped bypassing ST's generate pipeline) re-enters here, sees the depth and
    // returns immediately. Without it that re-entry is unbounded recursion — the
    // lookup runs INSIDE the handler, unlike extraction, whose worst case is a
    // stray injection. It also fixes the two-concurrent-passes case, where the
    // second entry overwrote lookupAbort and left the first leg uncancellable.
    //
    // This is NOT the guard the two injection handlers deliberately refuse (see
    // their comments): those must inject the sheet during a background run, and
    // guarding them dropped real injections. Skipping the LOOKUP during one costs
    // nothing that was already computed — the sheet still goes in — and it keeps
    // two agent passes off the same connection profile at once.
    //
    // The cost of RAISING it here is the mirror of that: runMemoryExtraction also
    // bails on isInternalCall(), so a connection auto-retry landing inside this
    // pass's window is skipped. Bounded by the deadline (≤8s, against the minutes
    // extraction and reflection already hold it for) and not lost — the per-message
    // watermarks mean the next trigger re-covers the same stretch.
    if (isInternalCall()) {
        addDebugLog('debug', 'Lookup skipped — another BF Memory pass is already holding the internal-call depth', {
            subsystem: 'agent3', event: 'lookup.skip', reason: 'INTERNAL_CALL',
            data: { path },
        });
        return sheetText;
    }

    const runId = `lookup${++lookupSeq}`;
    // Absolute, taken BEFORE the first await and handed to every stage, so the
    // budget is shared rather than restarted per stage.
    const deadlineAt = Date.now() + LOOKUP_TIMEOUT_MS;
    let backstop = null;
    internalCallDepth++;
    try {
        const backstopP = new Promise((resolve) => {
            backstop = setTimeout(() => resolve(LOOKUP_BACKSTOP), LOOKUP_TIMEOUT_MS + LOOKUP_DEADLINE_GRACE_MS);
        });
        const outcome = await Promise.race([runLookupPass(sheetText, path, runId, deadlineAt), backstopP]);
        if (outcome === LOOKUP_BACKSTOP) {
            // Fire the abort so the orphaned leg stops opening new rounds, then
            // leave. The per-stage deadline should have returned control 250ms
            // ago; that it did not means an await inside the pass is not raced.
            abortLookupPass('backstop');
            addDebugLog('fail', `[${runId}] Lookup pass blew past its own ${LOOKUP_TIMEOUT_MS}ms deadline — the ${LOOKUP_TIMEOUT_MS + LOOKUP_DEADLINE_GRACE_MS}ms backstop released the generation. An await inside the pass is not covered by a per-stage race.`, {
                subsystem: 'agent3', event: 'lookup.run', reason: 'DEADLINE_BACKSTOP',
                data: { path, timeoutMs: LOOKUP_TIMEOUT_MS, backstopMs: LOOKUP_TIMEOUT_MS + LOOKUP_DEADLINE_GRACE_MS },
            });
            return sheetText;
        }
        return outcome;
    } catch (err) {
        // The belt. runLookupPass catches its own failures, so this only ever sees
        // something the race plumbing itself threw — but the caller is a
        // generation handler and must never see an exception from here.
        addDebugLog('fail', `[${runId}] Lookup deadline plumbing failed (non-fatal — the prompt goes out without it): ${err?.message || err}`, {
            subsystem: 'agent3', event: 'lookup.run', reason: 'ERROR',
        });
        return sheetText;
    } finally {
        if (backstop) clearTimeout(backstop);
        // CHAT_CHANGED zeroes the counter outright; the floor keeps that from
        // going negative and permanently un-guarding the pass.
        internalCallDepth = Math.max(0, internalCallDepth - 1);
    }
}

// The pass itself. Split out so appendLookupBlock is nothing but the gates and
// the backstop race — the enforcement is then readable in one screen, and every
// await that could hold a generation sits on the other side of that race.
async function runLookupPass(sheetText, path, runId, deadlineAt) {
    const settings = getSettings();
    try {
        const ctx = SillyTavern.getContext();
        const chatId = String(ctx.getCurrentChatId?.() || ctx.chatId || '');
        const avatar = ctx.characters?.[ctx.characterId]?.avatar || '';

        const { message, prior } = newestUserExchange();
        if (!message) return sheetText;
        // "ok", "*nods*", an [OOC:] aside — the same filter extraction uses to
        // decide a message carries nothing worth an LLM call. Searching the store
        // for a nod is pure latency.
        if (isTriviallyEmptyForExtraction(message)) {
            addDebugLog('debug', `[${runId}] Lookup skipped — newest user message is trivially empty (${message.length} chars)`, {
                subsystem: 'agent3', event: 'lookup.skip', reason: 'TRIVIAL_MESSAGE',
                data: { path, chars: message.length },
            });
            return sheetText;
        }
        // A catch-up import rebuilds the whole store and drives its own extraction
        // batches; searching a store mid-rebuild is at best wasted latency.
        // This await is the one the backstop race exists for: a dynamic import is
        // a network fetch the first time it runs and takes no signal.
        try {
            const { isCatchupRunning } = await import('./catchup-import.js');
            if (isCatchupRunning()) {
                addDebugLog('info', `[${runId}] Lookup skipped — catch-up import in progress`, {
                    subsystem: 'agent3', event: 'lookup.skip', reason: 'CATCHUP_RUNNING',
                });
                return sheetText;
            }
        } catch {  }

        let refs;
        if (lastLookup && lastLookup.chatId === chatId && lastLookup.avatar === avatar && lastLookup.message === message) {
            refs = lastLookup.refs;
            addDebugLog('debug', `[${runId}] Lookup reused — same user message as the last pass (${refs.length} ref(s), no LLM call, no wait)`, {
                subsystem: 'agent3', event: 'lookup.skip', reason: 'REUSED_SAME_MESSAGE',
                data: { path, refs: refs.map(r => `${r.category}/${r.key}`) },
            });
        } else {
            lookupAbort = new AbortController();
            let res;
            try {
                res = await runLookupAgent({
                    userMessage: message,
                    priorMessage: prior,
                    sheetText,
                    profileId: settings.lookupProfile || settings.agent3Profile || null,
                    signal: lookupAbort.signal,
                    // The SAME absolute deadline the backstop above is measured
                    // from, minus nothing: whatever the gates above spent is
                    // already gone from the agent's share.
                    deadlineAt,
                    runId,
                });
            } finally {
                lookupAbort = null;
            }

            if (res.timedOut) {
                // The latch counts BOTH stages. Its contract is "stop paying dead
                // latency on every message", and a store that never loads in time
                // costs that just as surely as a slow model does — but the advice
                // differs, so the stage is carried into the message rather than
                // blaming a profile that may be innocent.
                lookupTimeoutStrikes++;
                if (lookupTimeoutStrikes >= LOOKUP_TIMEOUT_STRIKES) {
                    lookupOffForSession = true;
                    const cause = res.stage === 'store'
                        ? `the memory store did not load inside the ${LOOKUP_TIMEOUT_MS}ms budget ${lookupTimeoutStrikes}x — that is storage (attachment fetch / IndexedDB), not the lookup model`
                        : `${lookupTimeoutStrikes} consecutive ${LOOKUP_TIMEOUT_MS}ms deadline misses. Point it at a faster connection profile (or untick it)`;
                    addDebugLog('fail', `Lookup agent switched OFF for this session — ${cause}; switching chats or re-ticking the setting re-arms it.`, {
                        subsystem: 'agent3', event: 'lookup.disabled', reason: 'TIMEOUT_STRIKES',
                        data: { strikes: lookupTimeoutStrikes, stage: res.stage || null, timeoutMs: LOOKUP_TIMEOUT_MS },
                    });
                    toastPipelineError(res.stage === 'store'
                        ? `Lookup agent disabled for this session — the memory store missed the ${LOOKUP_TIMEOUT_MS / 1000}s load budget ${lookupTimeoutStrikes}x.`
                        : `Lookup agent disabled for this session — it missed the ${LOOKUP_TIMEOUT_MS / 1000}s deadline ${lookupTimeoutStrikes}x. Give it a faster connection profile.`);
                }
                return sheetText;
            }
            // Only a completed pass clears the streak: an error is not evidence
            // the model is fast enough, but it is not a deadline miss either, so
            // it neither clears nor arms the latch.
            if (!res.error) lookupTimeoutStrikes = 0;
            if (res.error) return sheetText;

            refs = res.refs;
            lastLookup = { chatId, avatar, message, refs };
        }

        if (!refs.length) return sheetText;

        // The awaits above are seconds long. A chat or character switch inside
        // that window means these refs describe another store entirely — and this
        // prompt is no longer the one they were found for.
        const liveCtx = SillyTavern.getContext();
        const liveChatId = String(liveCtx.getCurrentChatId?.() || liveCtx.chatId || '');
        const liveAvatar = liveCtx.characters?.[liveCtx.characterId]?.avatar || '';
        if (liveAvatar !== avatar || (chatId && liveChatId && liveChatId !== chatId)) {
            addDebugLog('info', `[${runId}] Lookup block dropped — character or chat changed while the pass ran (${avatar}/${chatId} -> ${liveAvatar}/${liveChatId})`, {
                subsystem: 'agent3', event: 'lookup.skip', reason: 'CONTEXT_CHANGED',
            });
            return sheetText;
        }

        // Same deadline again, not a fresh one: on the REUSED path above no agent
        // ran, so this is the pass's first store touch — and any save since the
        // last lookup has invalidated the cache, which makes it the cold load.
        const { block } = await renderLookupBlock({ refs, sheetText, runId, deadlineAt });
        if (!block) return sheetText;
        // Appended, never prepended: the standing sheet keeps its exact shape and
        // its header stays the first line of the injection. With no sheet yet
        // (new chat, shared database profile) the block is injected on its own —
        // which is the right answer, not an edge case to suppress.
        return sheetText ? `${sheetText}\n${block}` : block;
    } catch (err) {
        addDebugLog('fail', `[${runId}] Lookup pass failed (non-fatal — the prompt goes out without it): ${err?.message || err}`, {
            subsystem: 'agent3', event: 'lookup.run', reason: 'ERROR',
        });
        return sheetText;
    }
}

// --- User-visible error stream (separate from the debug log) ---------------
// A memory-pipeline run failing must NOT interrupt chat (the run is post-reply
// and every branch is already caught) — it should only raise a toast. Throttled
// so a per-turn recurring failure can't spam: an identical message is suppressed
// within the window; a *different* error always surfaces immediately.
let lastErrToastMsg = '';
let lastErrToastAt = 0;
const ERROR_TOAST_THROTTLE_MS = 60000;

function toastPipelineError(msg) {
    try {
        const settings = getSettings();
        if (!settings || settings.showToast === false) return;
        if (typeof toastr === 'undefined') return;
        const now = Date.now();
        if (msg === lastErrToastMsg && (now - lastErrToastAt) < ERROR_TOAST_THROTTLE_MS) return;
        lastErrToastMsg = msg;
        lastErrToastAt = now;
        toastr.error(String(msg), 'BF Memory', { timeOut: 6000, preventDuplicates: true });
    } catch {  }
}

// Auto-retry decision point for a failed extraction run. Only connection-class
// failures qualify (isConnectionFailure — timeout/abort/network/fetch/budget);
// protocol errors would just repeat identically. Cancelled-by-user runs never
// auto-retry (the user asked for silence, and the abort error they produced is
// indistinguishable from a network abort). One retry per failure streak; the
// streak resets on the next user message or a successful run.
function maybeScheduleConnectionRetry(runId, errMsg) {
    if (!isConnectionFailure(errMsg)) return;
    if (pipelineCancelled) {
        addDebugLog('info', `[${runId}] Connection-class failure on a cancelled run — no auto-retry (user cancel wins)`, {
            subsystem: 'pipeline', event: 'extraction.auto_retry', reason: 'CANCELLED',
        });
        return;
    }
    connectionFailureStreak++;
    if (connectionFailureStreak >= 2) {
        addDebugLog('info', `[${runId}] Connection failure #${connectionFailureStreak} in a row — auto-retry already spent, extraction parked until the next message (watermarks keep the backlog safe)`, {
            subsystem: 'pipeline', event: 'extraction.retry_parked', reason: 'SECOND_CONNECTION_FAILURE',
            data: { streak: connectionFailureStreak, error: String(errMsg).slice(0, 200) },
        });
        return;
    }
    if (connectionRetryTimer) return; // single-flight: never stack retries
    addDebugLog('info', `[${runId}] Connection-class failure (${String(errMsg).slice(0, 120)}) — ONE automatic retry in ${CONNECTION_RETRY_DELAY_MS / 1000}s`, {
        subsystem: 'pipeline', event: 'extraction.auto_retry',
        data: { delayMs: CONNECTION_RETRY_DELAY_MS, error: String(errMsg).slice(0, 200) },
    });
    toastPipelineError(`Memory update hit a connection error — retrying automatically in ${CONNECTION_RETRY_DELAY_MS / 1000}s`);
    connectionRetryTimer = setTimeout(() => {
        connectionRetryTimer = null;
        runMemoryExtraction();
    }, CONNECTION_RETRY_DELAY_MS);
}

function firstInjectableArray(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.chat, data.messages, data.prompt, data.chatCompletion, data.messageArray];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return null;
}

async function countChatTokens(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const ctx = SillyTavern.getContext();
    try {
        if (ctx.countTokensOpenAIAsync) return await ctx.countTokensOpenAIAsync(arr, true);

        let total = 0;
        for (const m of arr) total += await (ctx.getTokenCountAsync?.(m.content || m.mes || '') ?? 0);
        return total;
    } catch { return 0; }
}

function recordRunTokens({ baselineInput, actualInput, sheetTokens, path }) {
    try {
        setRunTokens({
            baselineInput: baselineInput || 0,
            actualInput: actualInput || 0,
            sheetTokens: sheetTokens || 0,
            mainOutput: 0,
            // 'chat' (chat-completion, trim possible) or 'text' (text-completion,
            // no trim exists) — drives which banner the tokens panel shows.
            path: path || 'chat',
        });
        runRecordedInput = true;
    } catch (err) {
        addDebugLog('info', `Token recording failed (non-fatal): ${err.message || err}`);
    }
}

async function countTextTokens(text) {
    const t = String(text ?? '');
    if (!t) return 0;
    try {
        const ctx = SillyTavern.getContext();
        return await (ctx.getTokenCountAsync?.(t) ?? 0);
    } catch { return 0; }
}

function getCharacterInfo() {
    const context = SillyTavern.getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return '';

    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 2000)}`);
    if (char.personality) parts.push(`Personality: ${char.personality.substring(0, 1000)}`);
    if (char.scenario) parts.push(`Scenario: ${char.scenario.substring(0, 1000)}`);
    return parts.join('\n');
}

function getCharacterInfoBrief() {
    const context = SillyTavern.getContext();
    const char = context?.characters?.[context?.characterId];
    if (!char) return '';
    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 400)}`);
    return parts.join('\n');
}

function getUserPersona() {
    const context = SillyTavern.getContext();
    return context.persona?.description || context.name1 || '';
}

function showWorkingIndicator() {
    let indicator = document.getElementById('bf_mem_working_indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'bf_mem_working_indicator';
        indicator.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Memory Pipeline: updating memory...';
        indicator.style.cssText = `
            display: flex; align-items: center; gap: 8px;
            padding: 10px 15px; margin: 5px 0;
            background: var(--SmartThemeBlurTintColor, #1a1a2e);
            border: 1px solid var(--SmartThemeBorderColor, #444);
            border-radius: 6px; color: #7bb3ff; font-size: 13px;
        `;
        const sendForm = document.getElementById('send_form');
        if (sendForm) {
            sendForm.parentNode.insertBefore(indicator, sendForm);
        }
    }
    indicator.style.display = 'flex';
}

function hideWorkingIndicator() {
    const indicator = document.getElementById('bf_mem_working_indicator');
    if (indicator) indicator.style.display = 'none';
}

// Abort the in-flight reflection pass, if any. Idempotent, and a no-op when
// nothing is running. Aborting is deliberately NON-FATAL: runReflection returns a
// result object carrying .error instead of throwing. Nothing here touches
// reflectionInFlight — only maybeRunReflection's finally clears that, so an abort
// can never wedge the single-flight latch.
//
// Whether the repairs the earlier rounds already applied SURVIVE depends on WHY
// the pass stopped, and runReflection makes that call, not this function. A plain
// Stop persists them: the context still matches, so the drain runs. A chat or
// character switch does not — CHAT_CHANGED may swap the whole working store out
// from under the pass (autoSaveDbProfile), so the repairs are dropped unsaved
// rather than risk landing on another chat's store. The `reflection.done` log
// line records which happened and how many repairs it cost.
function abortReflectionPass(reason) {
    const ctrl = reflectionAbort;
    if (!ctrl || ctrl.signal.aborted) return;
    try { ctrl.abort(new DOMException(`Reflection aborted (${reason})`, 'AbortError')); } catch {  }
    addDebugLog('info', `Reflection pass aborted (${reason}) — the tool loop stops at the next round/tool boundary; repairs already applied are persisted unless the chat or character also changed`, {
        subsystem: 'reflection', event: 'reflection.abort', reason: String(reason).toUpperCase(),
    });
}

export function cancelActiveRun(reason = 'cancel') {
    pipelineCancelled = true;
    clearInjectedGuard();
    runRecordedInput = false;

    // A user cancel also withdraws any pending timeout auto-retry — the parked
    // exchange stays safe behind the watermarks until the next message.
    if (connectionRetryTimer) { clearTimeout(connectionRetryTimer); connectionRetryTimer = null; }

    try { cancelInFlightLLM(reason); } catch {  }
    // Same event, two layers: cancelInFlightLLM chops the leg that is in the
    // air, the signal stops the loop from starting another one.
    abortReflectionPass(reason);
    // The lookup pass returns on its own deadline regardless, so this only
    // shortens the wait — but a cancelled generation should not keep an LLM leg
    // and two tool rounds alive for a prompt that is no longer going anywhere.
    abortLookupPass(reason);
    hideWorkingIndicator();
    updateStatus('idle');
    addDebugLog('info', `Active pipeline run cancelled (${reason}) — in-flight LLM calls aborted`, {
        subsystem: 'pipeline', event: 'pipeline.cancel', reason: reason.toUpperCase(),
    });
}

function setInjectedGuard() {
    pipelineJustInjected = true;
    if (injectedResetTimer) clearTimeout(injectedResetTimer);
    injectedResetTimer = setTimeout(() => {
        injectedResetTimer = null;
        pipelineJustInjected = false;
    }, 2000);
}

function clearInjectedGuard() {
    pipelineJustInjected = false;
    if (injectedResetTimer) { clearTimeout(injectedResetTimer); injectedResetTimer = null; }
}

function isGenuineMessage(m) {
    return !!(m && m.mes && !m.is_system && !m.extra?.type);
}

// Depth-and-count view of the extraction backlog. A message is "behind" when
// it is GENUINE, SETTLED (index <= chat.length-1-holdBack, so the hold-back no
// longer protects it) and not yet stamped bf_mem_processed === true. `lag` is
// the keep-depth from the newest message that still covers the OLDEST such
// message (chat.length - oldestIndex): trimming to the last `lag` messages
// never cuts an unprocessed message out of context. `count` is how many such
// messages exist (the user-facing backlog number). Both 0 when caught up.
// No stored state — recomputed from the per-message watermarks, so the value
// shrinks back on its own as extraction stamps messages.
export function computeCatchupLag() {
    try {
        const settings = getSettings();
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat;
        if (!Array.isArray(chat) || chat.length === 0) return { lag: 0, count: 0 };

        // Same hold-back clamp as runMemoryExtraction: 0..10, fallback 4.
        const rawHoldBack = Number(settings?.bufferHoldBack);
        const holdBack = Number.isFinite(rawHoldBack) ? Math.min(10, Math.max(0, Math.floor(rawHoldBack))) : 4;
        const maxIdx = chat.length - 1 - holdBack;

        let oldest = -1;
        let count = 0;
        for (let i = 0; i <= maxIdx; i++) {
            const m = chat[i];
            if (!isGenuineMessage(m)) continue;
            if (m.extra?.bf_mem_processed === true) continue;
            // Same trivial-empty filter as runMemoryExtraction: those messages
            // get stamped processed without an LLM call, so counting them here
            // would show a "behind" backlog no extraction run will ever shrink.
            if (isTriviallyEmptyForExtraction(m.mes)) continue;
            if (oldest < 0) oldest = i;
            count++;
        }
        if (oldest < 0) return { lag: 0, count: 0 };
        return { lag: chat.length - oldest, count };
    } catch {
        return { lag: 0, count: 0 };
    }
}

// Build a stable, position-independent id for a message the first time we touch
// it, and stash it on the message itself (extra.bf_uid) so it survives message
// deletes, edits, and branches. Composite of chatId (separates chats/branches),
// a to-the-second timestamp (human-readable), and a random token (uniqueness).
function makeMsgUid(m) {
    const ctx = SillyTavern.getContext();
    const chatId = String(ctx.getCurrentChatId?.() || ctx.chatId || 'chat').replace(/\s+/g, '_');
    let ts = NaN;
    try { ts = (m?.send_date != null) ? new Date(m.send_date).getTime() : NaN; } catch { ts = NaN; }
    const t = Number.isFinite(ts) ? ts : Date.now();
    const stamp = new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, ''); // e.g. 20260712T142233
    let rand = '';
    try { rand = (globalThis.crypto?.randomUUID?.() || '').replace(/-/g, '').slice(0, 12); } catch {  }
    if (!rand) rand = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12);
    return `${chatId}::${stamp}::${rand}`;
}

function ensureMsgUid(m) {
    if (!m || typeof m !== 'object') return '';
    if (m.extra?.bf_uid) return m.extra.bf_uid;
    const uid = makeMsgUid(m);
    m.extra = { ...(m.extra || {}), bf_uid: uid };
    return uid;
}

function toAgentMessage(m, index) {
    return { index, uid: ensureMsgUid(m), role: m.is_user ? 'USER' : 'CHAR', name: String(m.name || '').trim(), text: m.mes };
}

// The spine contract is ONE sentence per batch. Enforcement is cooperative,
// not destructive: the LLM must put its sentence on an explicit "SENTENCE:"
// line (survives chatty preambles), and the reply is VALIDATED with the shared
// sentence-util counters. A multi-sentence reply triggers ONE rewrite call over
// the same batch; if it is STILL multi-sentence it is accepted as-is, because
// an extra sentence hurts the story far less than a sentence chopped off in
// the middle.
function spineSentencePrompt(count) {
    return `Summarize these ${count} roleplay messages as EXACTLY ONE past-tense sentence capturing what happened. Reply in exactly this format and nothing else:\nSENTENCE: <the one sentence>`;
}

// Deterministic "story so far" spine: for every completed block of N SETTLED
// genuine messages (N = settings.spineBatchSize, default 10), make ONE cheap
// LLM call to distil the block into a single past-tense sentence and APPEND it
// to the growing spine. Append-only — a batch is never re-summarized. The next
// block resumes AFTER the last covered message, located by its stable bf_uid
// (chat-index fallback), so deleting older messages or changing the batch size
// mid-chat can't double-cover or skip messages. Only SETTLED messages (older
// than the hold-back) are eligible — a message that can still be swiped/edited
// never ends up in a spine sentence. Fired once per successful memory run.
async function maybeAppendStorySpine(runId, profileId, capturedChatId = '') {
    try {
        const settings = getSettings();
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!Array.isArray(chat) || chat.length === 0) return;

        const liveChatId0 = String(ctx.getCurrentChatId?.() || ctx.chatId || '');
        if (capturedChatId && liveChatId0 && liveChatId0 !== capturedChatId) {
            addDebugLog('info', `[${runId}] Story spine skipped — chat changed before spine update (${capturedChatId} -> ${liveChatId0})`);
            return;
        }

        const rawBatch = Number(settings?.spineBatchSize);
        const batchSize = Number.isFinite(rawBatch) ? Math.min(30, Math.max(4, Math.floor(rawBatch))) : 10;

        const rawHoldBack = Number(settings?.bufferHoldBack);
        const holdBack = Number.isFinite(rawHoldBack) ? Math.min(10, Math.max(0, Math.floor(rawHoldBack))) : 4;
        const maxIdx = chat.length - 1 - holdBack;
        if (maxIdx < 0) return;

        const genuine = [];
        for (let i = 0; i <= maxIdx; i++) {
            if (isGenuineMessage(chat[i])) genuine.push({ index: i, m: chat[i] });
        }
        if (genuine.length === 0) return;

        const spine = getStorySpine();

        // Resume AFTER the last covered message: find it by stable uid first,
        // then by chat index (uid missing on legacy batches, or message deleted).
        let startPos = 0;
        if (spine.length > 0) {
            const last = spine[spine.length - 1];
            let pos = -1;
            if (last.endUid) pos = genuine.findIndex(g => g.m.extra?.bf_uid === last.endUid);
            if (pos < 0 && Number.isInteger(last.endMsg)) {
                for (let p = genuine.length - 1; p >= 0; p--) {
                    if (genuine[p].index <= last.endMsg) { pos = p; break; }
                }
            }
            if (pos < 0) {
                // Every message up to the last covered one was deleted — the settled
                // survivors were never summarized, so restart coverage at the front.
                addDebugLog('info', `[${runId}] Story spine anchor lost (covered messages deleted) — resuming coverage from the earliest settled message`);
            }
            startPos = pos + 1;
        }

        // Catch up incrementally: at most a couple of batches per run so a long or
        // freshly-imported chat (many complete blocks at once) doesn't fire a burst
        // of serial LLM calls in a single turn. The uid anchor makes spreading the
        // backfill across turns safe.
        const MAX_BATCHES_PER_RUN = 2;
        const nextIndex = spine.length > 0 ? (spine[spine.length - 1].batchIndex + 1) : 0;
        let appendedThisRun = 0;

        while (genuine.length - startPos >= batchSize && appendedThisRun < MAX_BATCHES_PER_RUN) {
            const slice = genuine.slice(startPos, startPos + batchSize);
            const startMsg = slice[0].index;
            const endMsg = slice[slice.length - 1].index;
            const endUid = ensureMsgUid(slice[slice.length - 1].m);
            const batchIndex = nextIndex + appendedThisRun;
            const transcript = slice
                .map(({ m }) => `${m.is_user ? 'USER' : 'CHAR'}${m.name ? ` (${String(m.name).trim()})` : ''}: ${String(m.mes || '').trim()}`)
                .join('\n\n');

            let sentence = '';
            try {
                sentence = extractSentenceLine(await callAgentLLM(
                    spineSentencePrompt(slice.length), transcript, profileId, 'story-spine',
                ));
                const ends = sentence ? countSentenceEnds(sentence) : 0;
                if (ends > 1) {
                    // Too many sentences: ONE rewrite call over the same batch.
                    addDebugLog('info', `[${runId}] Story spine batch ${batchIndex}: reply had ${ends} sentences — one rewrite call to condense`);
                    const rewritten = extractSentenceLine(await callAgentLLM(
                        `Your previous summary used more than one sentence. Condense these ${slice.length} roleplay messages into EXACTLY ONE past-tense sentence. Reply in exactly this format and nothing else:\nSENTENCE: <the one sentence>`,
                        transcript, profileId, 'story-spine-rewrite',
                    ));
                    if (rewritten) sentence = rewritten;
                    const stillEnds = countSentenceEnds(sentence);
                    if (stillEnds > 1) {
                        addDebugLog('info', `[${runId}] Story spine batch ${batchIndex}: still ${stillEnds} sentences after rewrite — accepting as-is (never chopped)`);
                    }
                }
            } catch (err) {
                addDebugLog('info', `[${runId}] Story spine batch ${batchIndex} skipped (LLM error) — will retry next turn: ${err?.message || err}`);
                break;
            }
            if (!sentence) {
                addDebugLog('info', `[${runId}] Story spine batch ${batchIndex} produced no sentence — will retry next turn`);
                break;
            }

            // The LLM call awaited — re-check the chat so a mid-call switch can
            // never write this chat's sentence into the newly-opened chat's spine.
            const liveCtx = SillyTavern.getContext();
            const liveChatId = String(liveCtx.getCurrentChatId?.() || liveCtx.chatId || '');
            if (capturedChatId && liveChatId && liveChatId !== capturedChatId) {
                addDebugLog('info', `[${runId}] Story spine batch ${batchIndex} discarded — chat changed mid-call (${capturedChatId} -> ${liveChatId})`);
                return;
            }

            if (!appendStorySpineBatch({ batchIndex, startMsg, endMsg, endUid, sentence })) break;
            recordHealthEvent('spine', { status: 'ok', batchIndex, endMsg });
            appendedThisRun++;
            startPos += batchSize;
            addDebugLog('info', `[${runId}] Story spine: appended batch ${batchIndex} (msgs ${startMsg}–${endMsg}, ${sentence.length} chars)`, {
                subsystem: 'pipeline', event: 'spine.append',
                data: { batchIndex, startMsg, endMsg, chars: sentence.length },
            });
        }
    } catch (err) {
        addDebugLog('info', `Story spine update failed (non-fatal): ${err?.message || err}`);
    }
}

async function runMemoryExtraction() {
    if (memoryExtractionInFlight) {

        if (!extractionRetryAfterBusy) {
            extractionRetryAfterBusy = true;
            addDebugLog('info', 'Memory agent (post-reply): prior extraction still committing — ONE retry chained to its completion');
        }
        return;
    }
    // A run that actually starts supersedes any pending timeout auto-retry
    // (single-flight — the timer-fired call nulls the handle before landing here).
    if (connectionRetryTimer) { clearTimeout(connectionRetryTimer); connectionRetryTimer = null; }
    const settings = getSettings();
    if (!settings || !settings.enabled) return;
    if (isInternalCall()) return; 
    if (pipelineCancelled) {

        if (!cancelledRetryArmed) {
            cancelledRetryArmed = true;
            addDebugLog('info', 'Memory agent (post-reply): skipped — generation was stopped/cancelled; scheduling ONE retry so the completed exchange isn\'t silently dropped');

            // The retry must CLEAR the cancelled flag first — nothing else resets it
            // until the next MESSAGE_RECEIVED, so without this the retry would land
            // right back in this branch and never do anything.
            setTimeout(() => { pipelineCancelled = false; runMemoryExtraction(); }, 0);
        } else {
            addDebugLog('info', 'Memory agent (post-reply): still cancelled on retry — exchange left unprocessed (no further retries)');
        }
        return;
    }
    const ctx0 = SillyTavern.getContext();
    if (ctx0.groupId || ctx0.selected_group) return; 

    try {
        const { isCatchupRunning } = await import('./catchup-import.js');
        if (isCatchupRunning()) {
            addDebugLog('info', 'Memory agent (post-reply): catch-up import in progress — skipping (importer rebuilds the sheet itself)');
            return;
        }
    } catch {  }

    const chat = ctx0.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const rawHoldBack = Number(settings.bufferHoldBack);
    const holdBack = Number.isFinite(rawHoldBack) ? Math.min(10, Math.max(0, Math.floor(rawHoldBack))) : 4;
    const maxIdx = chat.length - 1 - holdBack;
    const SETTLED_BATCH_MAX = 12;

    const settledMessages = [];
    const trivialIndices = []; 
    for (let i = 0; i <= maxIdx; i++) {
        const m = chat[i];
        if (!isGenuineMessage(m)) continue;

        // true = done; false/absent = todo. A persisted 'in-flight' stamp can only
        // be a leftover from a run the browser/tab killed mid-flight (no extraction
        // is running while this scan executes) — treat it as unprocessed so those
        // messages get re-extracted instead of being skipped forever.
        if (m.extra?.bf_mem_processed === true) continue;
        if (isTriviallyEmptyForExtraction(m.mes)) { trivialIndices.push(i); continue; }
        settledMessages.push(toAgentMessage(m, i));
    }
    if (settledMessages.length > SETTLED_BATCH_MAX) {
        // Keep the OLDEST slice of the backlog: extraction must stay chronological
        // ACROSS runs. Keeping the newest would extract the leftover OLD messages
        // on a LATER run, letting stale values overwrite fresher state (a fact from
        // msg 5 clobbering the update from msg 15). The dropped newer tail stays
        // unstamped and is picked up next run.
        settledMessages.length = SETTLED_BATCH_MAX;
    }

    const tentativeMessages = [];
    for (let i = Math.max(0, maxIdx + 1); i < chat.length; i++) {
        const m = chat[i];
        if (!isGenuineMessage(m)) continue;
        tentativeMessages.push(toAgentMessage(m, i));
    }

    if (trivialIndices.length > 0) {
        for (const i of trivialIndices) {
            chat[i].extra = { ...(chat[i].extra || {}), bf_mem_processed: true };
        }
        SillyTavern.getContext().saveChatDebounced?.();
        addDebugLog('info', `Memory agent (post-reply): ${trivialIndices.length} trivially-empty settled msg(s) stamped processed without an LLM call`);
        // Repaint icons + catch-up badge now: a trivial-only run returns at the
        // "no settled messages" early-return below, before setWatermark (the
        // usual repaint trigger) ever runs, which would leave the just-stamped
        // messages' icons — and a stale "N behind" badge — on screen.
        import('./message-icon.js').then(m => m.refreshMessageIcons?.()).catch(() => {});
    }

    // Only run once there is at least one SETTLED message to extract (index
    // <= chat.length-1-holdBack, not yet processed). With no settled messages
    // there is nothing new to store, and firing a sheet-refresh-only run this
    // early (e.g. on the first message, when everything is still tentative)
    // just makes the agent reply with prose — no tool call, no #SHEET — which
    // trips the protocol "second offense" abort for no reason. This is the
    // n-4 rule: nothing runs until a message is old enough to settle.
    if (settledMessages.length === 0) {
        addDebugLog('info', `Memory agent (post-reply): no settled messages yet (hold-back ${holdBack}) — nothing new to extract, skipping the run`);
        return;
    }

    const capturedDbProfile = settings.activeDbProfile;
    const capturedCharAvatar = ctx0.characters?.[ctx0.characterId]?.avatar || '';
    const capturedChatId = String(ctx0.getCurrentChatId?.() || ctx0.chatId || '');
    const startTime = Date.now();

    const pending = getPendingRun();
    const runId = pending?.runId || `M${startTime.toString(36).slice(-5)}`;
    beginRun(runId);

    const postStageMs = { agent3Ms: null, snapshotMs: null };

    const BF_MEM_IN_FLIGHT = 'in-flight';
    const settledIndices = settledMessages.map(m => m.index);
    // Stamp by stable uid, not by captured position: deleting a message while the
    // run is in flight shifts positions, and a positional stamp would then hit the
    // WRONG message. The uid lookup finds each settled message wherever it now
    // sits and silently skips ones that were deleted mid-run.
    const settledUids = new Set(settledMessages.map(m => m.uid).filter(Boolean));
    const setWatermark = (val) => {
        let changed = false;
        for (const msg of chat) {
            const uid = msg?.extra?.bf_uid;
            if (!uid || !settledUids.has(uid)) continue;
            if (msg.extra.bf_mem_processed !== val) {
                msg.extra = { ...msg.extra, bf_mem_processed: val };
                changed = true;
            }
        }
        if (changed) SillyTavern.getContext().saveChatDebounced?.();
        // Repaint the on-screen brain icons when the flag settles to true/false
        // (skip the transient 'in-flight' marker) so green appears immediately.
        if (val === true || val === false) {
            import('./message-icon.js').then(m => m.refreshMessageIcons?.()).catch(() => {});
        }
    };
    setWatermark(BF_MEM_IN_FLIGHT);

    // Both exits below snapshot the working store into the profile this run
    // started under. saveCurrentToActiveProfile pins the profile NAME and
    // nothing else: it reads getAllDatabases() / getStorySpine() /
    // getCurrentScene() LIVE and overwrites dbProfiles[name] wholesale, so after
    // a mid-run profile switch it would write the newly loaded profile's data
    // into capturedDbProfile and destroy that snapshot. Read live at call time
    // rather than captured once — the switch can land anywhere in the run.
    //
    // Deliberately NOT folded into the character/chat guard below: that guard
    // discards the whole result, and a profile switch does not invalidate the
    // extracted facts the way a character switch does. The chat is still open,
    // the facts still describe it and are already in the working store, so only
    // the snapshot is skipped — watermark and sheet still commit. Same gate as
    // maybeRunReflection and catchup-import.js, narrower consequence.
    const snapshotToCapturedProfile = async () => {
        const liveDbProfile = (getSettings() || {}).activeDbProfile;
        if (liveDbProfile !== capturedDbProfile) {
            addDebugLog('fail', `[${runId}] Profile snapshot skipped — database profile changed mid-extraction ("${capturedDbProfile}" -> "${liveDbProfile}"); facts are still in the working store`, {
                subsystem: 'agent3', event: 'agent3.snapshotSkipped', reason: 'PROFILE_CHANGED',
                data: { capturedDbProfile, liveDbProfile: liveDbProfile || null },
            });
            return;
        }
        const snapStart = Date.now();
        await saveCurrentToActiveProfile(capturedDbProfile);
        postStageMs.snapshotMs = Date.now() - snapStart;
    };

    memoryExtractionInFlight = true;

    cancelledRetryArmed = false;
    internalCallDepth++; 
    let memoryResult = null;

    let reachedCommit = false;
    try {
        showWorkingIndicator();

        const characterInfo = getCharacterInfoBrief();
        const userPersona = getUserPersona();

        addDebugLog('info', `[${runId}] Memory agent (post-reply): ${settledMessages.length} settled (hold-back ${holdBack}, msgs ${settledIndices.length ? `${settledIndices[0]}–${settledIndices[settledIndices.length - 1]}` : '—'}), ${tentativeMessages.length} tentative`);

        const agent3ProfileId = settings.agent3Profile || null;
        const agent3Start = Date.now();

        let observationDate;
        try {
            const newest = settledMessages[settledMessages.length - 1] || tentativeMessages[tentativeMessages.length - 1];
            const sd = (newest && Number.isInteger(newest.index)) ? chat[newest.index]?.send_date : null;
            const ts = (sd != null) ? new Date(sd).getTime() : NaN;
            observationDate = (Number.isFinite(ts) ? new Date(ts) : new Date()).toISOString();
        } catch (_) {
            observationDate = new Date().toISOString();
        }

        // The sheet as it stands BEFORE this run writes its own (this run's
        // setMemorySheet calls are further down, at the extraction-error branch
        // and the success branch — both strictly after this point), i.e. the
        // sheet that was injected above the replies this run is about to judge.
        //
        // That identity holds in the steady state ONLY. When the pipeline lags
        // the chat — a slow tool loop, a coalesced retry, the whole
        // computeCatchupLag machinery — the user can generate reply N+1 while
        // run R_N is still in flight; R_N then commits sheet S_k, and the run
        // for N+1 reads S_k although N+1 was generated under S_(k-1). The
        // omission-recovery list would then be asserted about the wrong sheet.
        // So the record's OWN identity travels with it: `priorSheet` carries the
        // runId and the sourceMessageIndex the sheet was built for, and
        // `newestJudgedMessageIndex` says which message this run is judging.
        // The comparison itself belongs to the extraction agent, not here.
        const priorSheet = getMemorySheet();
        const newestJudged = tentativeMessages.length > 0
            ? tentativeMessages[tentativeMessages.length - 1].index
            : settledMessages[settledMessages.length - 1].index;

        memoryResult = await runMemoryAgent({
            settledMessages,
            tentativeMessages,
            characterInfo,
            userPersona,
            profileId: agent3ProfileId,
            priorSheetText: priorSheet?.text || '',
            // Snapshot COPY of the whole sheet record — never the live singleton
            // getMemorySheet() returns, which setMemorySheet replaces wholesale
            // and which nothing downstream may mutate.
            priorSheet: priorSheet ? {
                text: String(priorSheet.text || ''),
                runId: String(priorSheet.runId || ''),
                // Chat index of the newest message that existed when this sheet
                // was composed (chat.length - 1 at that moment). -1 = unknown /
                // seed sheet.
                sourceMessageIndex: Number.isInteger(priorSheet.sourceMessageIndex) ? priorSheet.sourceMessageIndex : -1,
                updatedAt: String(priorSheet.updatedAt || ''),
                // true = the "Story just beginning" seed, never a composed sheet.
                seeded: priorSheet.seeded === true,
            } : null,
            // Chat index of the NEWEST message this run is judging (the last
            // tentative one, or the last settled one when nothing is tentative).
            // Compare against priorSheet.sourceMessageIndex to decide whether the
            // sheet really is the one that stood above this reply.
            newestJudgedMessageIndex: newestJudged,
            reflection: getReflection(),
            observationDate,
            runId,
            extractOnly: false,
        }).catch(err => ({ sheetText: null, applied: [], error: err.message, tokensIn: 0, tokensOut: 0, rounds: 0, toolCallCount: 0 }));
        postStageMs.agent3Ms = Date.now() - agent3Start; 

        addAgent3Tokens({ agent3Input: memoryResult?.tokensIn || 0, agent3Output: memoryResult?.tokensOut || 0 });

        if (!memoryResult || memoryResult.error) {
            if (memoryResult?.error) addDebugLog('fail', `[${runId}] Memory agent error: ${memoryResult.error}`, {
                subsystem: 'agent3', event: 'agent3.run', reason: 'ERROR',
                data: { agent: 'memory-agent', profileId: agent3ProfileId, success: false, error: memoryResult.error, durationMs: Date.now() - startTime },
            });
            if (memoryResult?.error) toastPipelineError(`Memory update failed: ${memoryResult.error}`);
            recordHealthEvent('extraction', { status: 'fail', error: memoryResult?.error || 'no result', calls: memoryResult?.calls || null });

            setWatermark(false);
            maybeScheduleConnectionRetry(runId, memoryResult?.error || 'no result');
            return;
        }

        reachedCommit = true;

        const committed = (memoryResult.applied || []).map(({ category, key, fact, status }) => ({
            category,
            key,
            value: String(fact?.value ?? ''),
            tags: Array.isArray(fact?.tags) ? fact.tags : [],
            knownBy: Array.isArray(fact?.knownBy) ? fact.knownBy : [],
            context: (typeof fact?.context === 'string' && fact.context) ? fact.context : undefined,
            source: fact?.source,
            status: status || 'NEW',
            changed: true,
        }));
        setLastGenerated(committed);

        if (pipelineCancelled) {
            addDebugLog('info', `[${runId}] Cancelled mid-extraction — withholding watermark/sheet (${committed.length} write(s) already stored)`);
            setWatermark(false); 
            setLastInserted(committed);
            return;
        }

        const liveCtx = SillyTavern.getContext();
        const currentCharAvatar = liveCtx.characters?.[liveCtx.characterId]?.avatar || '';
        const currentChatId = String(liveCtx.getCurrentChatId?.() || liveCtx.chatId || '');
        // Guard BOTH character switches and chat/branch switches (same character,
        // different chat) — either way the sheet/watermark must not be applied to
        // the chat that is now active. A mid-run DB-profile switch is NOT checked
        // here: it invalidates only where the snapshot lands, not the result, so
        // snapshotToCapturedProfile gates that separately.
        if (currentCharAvatar !== capturedCharAvatar || (capturedChatId && currentChatId && currentChatId !== capturedChatId)) {
            addDebugLog('fail', `[${runId}] Character or chat changed mid-extraction (${capturedCharAvatar}/${capturedChatId} -> ${currentCharAvatar}/${currentChatId}) — withholding watermark/sheet`);
            if (typeof toastr !== 'undefined') {
                toastr.warning('BF Memory: extraction result discarded — you switched characters or chats');
            }
            setWatermark(false);
            setLastInserted(committed);
            return;
        }

        // Isolated extraction failure: Call A (facts + NEED) failed, but the beat
        // and sheet-head passes still refreshed the sheet. Commit the sheet, but
        // HOLD the watermark FALSE so this exchange re-extracts next run. Writes
        // Call A salvaged before erroring are already in the working store — they
        // must be snapshotted like the success path does, or a later profile load
        // would rebuild from a stale snapshot and drop them. Skip the
        // spine/reflection steps this run.
        if (memoryResult.extractionError) {
            addDebugLog('fail', `[${runId}] Extraction failed (sheet still refreshed, watermark held): ${memoryResult.extractionError}`, {
                subsystem: 'agent3', event: 'agent3.run', reason: 'EXTRACTION_FAILED',
                data: { agent: 'memory-agent', profileId: agent3ProfileId, success: false, error: memoryResult.extractionError, durationMs: Date.now() - startTime },
            });
            toastPipelineError(`Memory extraction failed: ${memoryResult.extractionError}`);
            recordHealthEvent('extraction', { status: 'fail', error: memoryResult.extractionError, calls: memoryResult.calls || null });
            setLastInserted(committed);
            if (memoryResult.sheetText) {
                setMemorySheet(memoryResult.sheetText, { runId, sourceMessageIndex: chat.length - 1 });
            }
            if (committed.length > 0) {
                await snapshotToCapturedProfile();
            }
            setWatermark(false);
            return;
        }

        addDebugLog('info', `[${runId}] Memory agent: ${committed.length} committed write(s), ${memoryResult.rounds} round(s), ${memoryResult.toolCallCount} tool call(s)`, {
            subsystem: 'agent3', event: 'agent3.run',
            data: {
                agent: 'memory-agent', profileId: agent3ProfileId, success: true,
                durationMs: Date.now() - startTime, settled: settledMessages.length, tentative: tentativeMessages.length, holdBack,
                tokensIn: memoryResult.tokensIn ?? null, tokensOut: memoryResult.tokensOut ?? null,
                committed: committed.length, rounds: memoryResult.rounds, toolCallCount: memoryResult.toolCallCount,
            },
        });
        setLastInserted(committed);
        recordHealthEvent('extraction', { status: 'ok', writes: committed.length, rounds: memoryResult.rounds, durationMs: Date.now() - startTime, calls: memoryResult.calls || null });
        connectionFailureStreak = 0; // a clean run ends any connection-failure streak

        if (memoryResult.sheetText) {
            setMemorySheet(memoryResult.sheetText, { runId, sourceMessageIndex: chat.length - 1 });
        }

        setWatermark(true);

        if (committed.length > 0) {
            await snapshotToCapturedProfile();
        }

        await maybeAppendStorySpine(runId, agent3ProfileId, capturedChatId);

        // The commit gate above proved the chat had not changed, but the spine
        // step just awaited up to two LLM calls. The progress counter is now
        // PERSISTED, so a bump landing after a switch would credit the newly
        // opened chat permanently instead of being wiped by the old CHAT_CHANGED
        // reset. Re-check before touching it, and skip arming too — a pass armed
        // for a chat that is no longer open has nothing to audit.
        const armCtx = SillyTavern.getContext();
        const armChatId = String(armCtx.getCurrentChatId?.() || armCtx.chatId || '');
        if (capturedChatId && armChatId && armChatId !== capturedChatId) {
            addDebugLog('info', `[${runId}] Reflection progress not counted — chat changed after the commit (${capturedChatId} -> ${armChatId})`, {
                subsystem: 'reflection', event: 'reflection.progress', reason: 'CHAT_CHANGED',
            });
            return;
        }

        const REFLECTION_INTERVAL = 12;
        const runsSinceReflection = bumpReflectionProgress();
        if (runsSinceReflection >= REFLECTION_INTERVAL && !reflectionPending && !reflectionInFlight) {
            reflectionPending = {
                runId, charAvatar: capturedCharAvatar, chatId: capturedChatId,
                profileId: settings.agent3Profile || null,
                characterInfo: getCharacterInfo(), userPersona,
            };
            addDebugLog('info', `[${runId}] Reflection armed (will run after settle; ${runsSinceReflection}/${REFLECTION_INTERVAL} runs)`);
        }
    } catch (err) {

        addDebugLog('fail', `[${runId}] Memory agent (post-reply) failed (non-fatal): ${err.message || err}`);
        recordHealthEvent('extraction', { status: 'fail', error: err.message || String(err), calls: memoryResult?.calls || null });
        toastPipelineError(`Memory update failed: ${err.message || err}`);
        maybeScheduleConnectionRetry(runId, err.message || String(err));

        if (!reachedCommit) {
            try {
                setWatermark(false);
                addDebugLog('info', `[${runId}] Memory agent: reset 'in-flight' watermark (throw before commit) — exchange will re-extract next turn`);
            } catch {  }
        }
    } finally {
        memoryExtractionInFlight = false;

        internalCallDepth = Math.max(0, internalCallDepth - 1);
        hideWorkingIndicator();

        if (extractionRetryAfterBusy) {
            extractionRetryAfterBusy = false;
            setTimeout(() => { runMemoryExtraction(); }, 0);
        }

        try {
            const postTotalMs = Date.now() - startTime;
            // agent3 wall time covers the whole 3-call split; the per-call
            // breakdown (extract tool-loop, then beats/head concurrently) comes
            // from runMemoryAgent's stageMs.
            const sub = memoryResult?.stageMs || null;
            const subTxt = sub
                ? ` (extract=${sub.extractMs ?? '-'}ms beats=${sub.beatsMs ?? '-'}ms head=${sub.headMs ?? '-'}ms)`
                : '';
            addDebugLog('debug',
                `[${runId}] Stage timing (post-reply): agent3=${postStageMs.agent3Ms ?? '-'}ms${subTxt} ` +
                `snapshot=${postStageMs.snapshotMs ?? '-'}ms total=${postTotalMs}ms`,
                {
                    runId, subsystem: 'pipeline', event: 'pipeline.timing',
                    data: { phase: 'post-reply', ...postStageMs, ...(sub || {}), totalMs: postTotalMs },
                },
            );
        } catch {  }
        endRun(); 
    }
}

// Build the raw-message evidence block for a reflection pass. Deliberately
// reuses the extraction path's shaping (toAgentMessage) and its exclusions —
// isGenuineMessage drops system/tool/empty rows, isTriviallyEmptyForExtraction
// drops [OOC:] / ((meta)) / sub-15-char noise — so the two agents can never
// disagree about what counts as story. No second message-shaping helper exists.
//
// Returns { messages, fromIndex, toIndex, chars, truncated, wanted }.
// `messages` is oldest-first, the same order the extraction task block uses.
function collectReflectionStoryMessages() {
    const empty = { messages: [], fromIndex: -1, toIndex: -1, chars: 0, truncated: false, wanted: 0 };
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx?.chat;
        if (!Array.isArray(chat) || chat.length === 0) return empty;

        // "Since the previous pass", clamped into the min/max band. The span is
        // measured in RAW indices while the walk below counts GENUINE messages,
        // so the clamp errs on the generous side — it can never under-cover the
        // stretch the previous pass did not see, which is the whole point.
        const since = lastReflectionChatIndex >= 0
            ? (chat.length - 1 - lastReflectionChatIndex)
            : REFLECT_STORY_MAX_MESSAGES;
        const wanted = Math.min(REFLECT_STORY_MAX_MESSAGES, Math.max(REFLECT_STORY_MIN_MESSAGES, since));

        // Walk backwards from the newest message: the window is anchored to the
        // present, and a shortfall (a chat shorter than `wanted`) simply yields
        // fewer rows.
        const picked = [];
        for (let i = chat.length - 1; i >= 0 && picked.length < wanted; i--) {
            const m = chat[i];
            if (!isGenuineMessage(m)) continue;
            if (isTriviallyEmptyForExtraction(m.mes)) continue;
            picked.push(toAgentMessage(m, i));
        }
        picked.reverse();
        if (picked.length === 0) return { ...empty, wanted };

        let chars = picked.reduce((n, m) => n + String(m.text || '').length, 0);
        let truncated = false;
        while (picked.length > 1 && chars > REFLECT_STORY_MAX_CHARS) {
            chars -= String(picked[0].text || '').length;
            picked.shift();
            truncated = true;
        }
        // One single message over the whole budget: slice it instead of dropping
        // it — an empty evidence block is strictly worse than a clipped one.
        if (picked.length === 1 && chars > REFLECT_STORY_MAX_CHARS) {
            const clipped = String(picked[0].text || '').slice(0, REFLECT_STORY_MAX_CHARS);
            picked[0] = { ...picked[0], text: clipped };
            chars = clipped.length;
            truncated = true;
        }

        return {
            messages: picked,
            fromIndex: picked[0].index,
            toIndex: picked[picked.length - 1].index,
            chars,
            truncated,
            wanted,
        };
    } catch (err) {
        // Non-fatal: reflection without story evidence is exactly the old
        // behaviour, so degrade to an empty window rather than skipping the pass.
        addDebugLog('fail', `Reflection story window failed (non-fatal, pass runs without evidence): ${err?.message || err}`, {
            subsystem: 'reflection', event: 'reflection.story_window', reason: 'ERROR',
        });
        return empty;
    }
}

async function maybeRunReflection() {
    const pending = reflectionPending;
    if (!pending || reflectionInFlight) return;
    const settings = getSettings();
    if (!settings || !settings.enabled) { reflectionPending = null; return; }
    if (pipelineCancelled) { reflectionPending = null; return; }
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) { reflectionPending = null; return; }

    const currentCharAvatar = ctx.characters?.[ctx.characterId]?.avatar || '';
    if (currentCharAvatar !== pending.charAvatar) {
        addDebugLog('info', `[${pending.runId}] Reflection skipped (character changed since arming)`);
        reflectionPending = null;
        return;
    }
    // Chat as well as character, and specifically because of the reset below:
    // CHAT_CHANGED clears reflectionPending, but only AFTER its first await, so a
    // switch to ANOTHER CHAT OF THE SAME CHARACTER can land in that window. The
    // progress counter is persisted per chat now, so an ungated pass would spend
    // the NEW chat's accumulated runs on the OLD chat's audit.
    const liveChatIdAtStart = String(ctx.getCurrentChatId?.() || ctx.chatId || '');
    if (pending.chatId && liveChatIdAtStart && liveChatIdAtStart !== pending.chatId) {
        addDebugLog('info', `[${pending.runId}] Reflection skipped (chat changed since arming: ${pending.chatId} -> ${liveChatIdAtStart})`, {
            subsystem: 'reflection', event: 'reflection.run', reason: 'CHAT_CHANGED',
        });
        reflectionPending = null;
        return;
    }

    reflectionPending = null;
    reflectionInFlight = true;
    // Spend the accumulated runs only once the pass is actually starting, and in
    // the chat it is starting in — every early return above leaves the progress
    // standing so the next settle re-arms instead of losing a whole interval.
    resetReflectionProgress();
    internalCallDepth++;
    const reflectStart = Date.now();
    // Installed BEFORE the first await so a Stop or a chat switch arriving one
    // tick later already has something to abort.
    const abortCtrl = new AbortController();
    reflectionAbort = abortCtrl;
    // Chat this pass was armed against — the guard above proved the live chat is
    // still it. Read twice below: to decide whether the story-window marker may
    // be rolled back, and to gate the profile snapshot. The pass's own fact
    // writes are guarded separately, inside agent-reflect.js.
    const capturedChatId = liveChatIdAtStart;
    // Snapshotted the way runMemoryExtraction snapshots it: getSettings() hands
    // back the LIVE object, and this pass runs long enough for the user to
    // switch database profiles under it — more so now that it can be aborted by
    // a chat switch, which often carries a profile switch. The post-pass
    // snapshot must land in the profile the repairs were made against.
    const capturedDbProfile = settings.activeDbProfile;
    const priorReflectionIndex = lastReflectionChatIndex;
    try {
        updateStatus('running', 'Reflecting (consolidating memory)...');

        // Story evidence. Collected HERE, not at arming time: arming happens at
        // the end of an extraction run, the pass itself runs after the next
        // settle, and the window must describe the chat as it is when the pass
        // actually reads it.
        const story = collectReflectionStoryMessages();
        if (story.messages.length > 0) {
            addDebugLog('info', `[${pending.runId}] Reflection story window: ${story.messages.length} msg(s) ${story.fromIndex}–${story.toIndex}, ${story.chars} chars${story.truncated ? ' (oldest trimmed to fit the char cap)' : ''}`, {
                subsystem: 'reflection', event: 'reflection.story_window',
                data: {
                    count: story.messages.length, fromIndex: story.fromIndex, toIndex: story.toIndex,
                    chars: story.chars, truncated: story.truncated, wanted: story.wanted,
                    sinceIndex: lastReflectionChatIndex,
                },
            });
            // Advance the marker as soon as the pass is committed to running.
            // A pass that then FAILS still counts as "covered": re-handing the
            // same stretch to the next pass would just repeat a failure, and the
            // min-window floor keeps the recent story in view regardless. A pass
            // the user ABORTS is the one exception and rolls this back below —
            // an interruption is not a failure that would repeat.
            lastReflectionChatIndex = story.toIndex;
        } else {
            addDebugLog('info', `[${pending.runId}] Reflection story window empty — pass runs against the digest alone`, {
                subsystem: 'reflection', event: 'reflection.story_window', reason: 'NO_MESSAGES',
            });
        }

        const reflResult = await runReflection({
            runId: pending.runId,
            characterInfo: pending.characterInfo || '',
            userPersona: pending.userPersona || '',
            profileId: pending.profileId || null,
            // Raw chat messages as EVIDENCE to check stored facts against.
            // Shape per entry: { index, uid, role: 'USER'|'CHAR', name, text } —
            // identical to what the extraction agent receives. Oldest-first.
            recentMessages: story.messages,
            // True when the oldest messages were dropped (or a single oversized
            // message clipped) to stay under REFLECT_STORY_MAX_CHARS. The window
            // is then NOT a complete record of the span — a fact absent from it
            // is not evidence of anything.
            recentMessagesTruncated: story.truncated,
            // Stop / extension-disable / chat switch. The pass mutates the
            // store, so it must be interruptible; the loop honours this between
            // rounds and between tool calls, never mid-write.
            signal: abortCtrl.signal,
        });

        try {
            const rIn = Number(reflResult?.tokensIn) || 0;
            const rOut = Number(reflResult?.tokensOut) || 0;
            if (rIn || rOut) {
                addReflectionTokens({ reflectionInput: rIn, reflectionOutput: rOut });
                addDebugLog('info', `[${pending.runId}] Reflection tokens: in=${rIn} out=${rOut}`, {
                    subsystem: 'reflection', event: 'reflection.run',
                    data: { agent: 'reflection', profileId: pending.profileId || null, tokensIn: rIn, tokensOut: rOut },
                });
            }
        } catch {  }

        // Runs on the abort path too: an abort that did NOT come with a context
        // change still leaves runReflection's per-category drain persisted, and
        // the profile snapshot has to follow it or a later profile load rebuilds
        // from a snapshot that predates those repairs.
        //
        // But ONLY while the live context still matches the one this pass ran
        // against. saveCurrentToActiveProfile pins the profile NAME and nothing
        // else: it reads getAllDatabases() / getStorySpine() / getCurrentScene()
        // LIVE and overwrites dbProfiles[name] wholesale. On the chat-switch
        // abort path CHAT_CHANGED has already invalidated the database cache, so
        // an ungated call reloads the NEWLY loaded character's facts and writes
        // them into the PREVIOUS character's profile, destroying that snapshot.
        // Pinning the name made that deterministic rather than merely racy, so
        // the gate has to travel with it. Same shape and same reason as the
        // snapshot gate in catchup-import.js.
        //
        // getContext() is wrapped: a throw here would otherwise land in the outer
        // catch and paint the Health row red for a pass that ran fine. Failing to
        // resolve the context means failing the gate — skip, never guess.
        let snapCtx = null;
        try { snapCtx = SillyTavern.getContext(); } catch {  }
        const snapChatId = String(snapCtx?.getCurrentChatId?.() || snapCtx?.chatId || '');
        const snapAvatar = snapCtx?.characters?.[snapCtx?.characterId]?.avatar || '';
        const snapshotContextUnchanged = !!snapCtx && snapChatId === capturedChatId
            && snapAvatar === currentCharAvatar
            && (getSettings() || {}).activeDbProfile === capturedDbProfile;
        if (snapshotContextUnchanged) {
            try { await saveCurrentToActiveProfile(capturedDbProfile); } catch {  }
        } else {
            // Nothing is lost that was not already abandoned: on a context change
            // runReflection discards its repairs unsaved rather than risk another
            // chat's store, so there is no persisted work here for the snapshot
            // to be missing.
            addDebugLog('fail', `[${pending.runId}] Reflection profile snapshot skipped — chat/character/profile changed mid-pass`, {
                subsystem: 'reflection', event: 'reflection.snapshotSkipped', reason: 'CONTEXT_CHANGED',
                data: { capturedChatId, liveChatId: snapChatId, capturedDbProfile },
            });
        }
        const reflectionMs = Date.now() - reflectStart;
        const reflRounds = Number(reflResult?.rounds) || 0;
        const reflToolCalls = Number(reflResult?.toolCallCount) || 0;
        // An abort also surfaces as reflResult.error ("aborted before round N" /
        // "aborted during tool execution"), but an interrupted pass is not a
        // broken one: it must not paint the Health row red, the same rule
        // llm-call.js applies to a user-cancelled LLM leg. No health event at
        // all on this path — the row keeps showing the last pass that actually
        // finished, and the abort is in the debug log.
        const wasAborted = abortCtrl.signal.aborted;
        if (wasAborted) {
            // The marker was advanced when the pass committed to running, on the
            // reasoning that a FAILED pass would only repeat its failure. An
            // abort is not that: the user interrupted, so hand the same stretch
            // back to the next pass. Compare-and-swap on the exact value this
            // pass wrote AND on the chat it was armed for — CHAT_CHANGED resets
            // the marker to -1, and a blind restore would push a dead chat's
            // index into the live one.
            const liveCtx = SillyTavern.getContext();
            const liveChatId = String(liveCtx.getCurrentChatId?.() || liveCtx.chatId || '');
            if (story.messages.length > 0 && lastReflectionChatIndex === story.toIndex && liveChatId === capturedChatId) {
                lastReflectionChatIndex = priorReflectionIndex;
                addDebugLog('info', `[${pending.runId}] Reflection aborted — story-window marker rolled back to ${priorReflectionIndex} so the next pass re-covers the interrupted stretch`, {
                    subsystem: 'reflection', event: 'reflection.story_window', reason: 'ABORT_ROLLBACK',
                    data: { restored: priorReflectionIndex, discarded: story.toIndex },
                });
            }
        } else if (reflResult?.error) {
            // A loop error surfaces as reflResult.error (runReflection never
            // throws for it) — report it as a fail instead of a false green.
            recordHealthEvent('reflection', { status: 'fail', error: reflResult.error, rounds: reflRounds, toolCallCount: reflToolCalls });
        } else {
            recordHealthEvent('reflection', { status: 'ok', durationMs: reflectionMs, rounds: reflRounds, toolCallCount: reflToolCalls });
        }
        addDebugLog('info', `[${pending.runId}] Reflection pass ${wasAborted ? 'ABORTED' : 'complete'} (${reflectionMs}ms, ${reflRounds} round(s), ${reflToolCalls} tool call(s)${wasAborted ? `; ${Number(reflResult?.toolWrites) || 0} repair(s) persisted before the abort` : ''})`, {
            subsystem: 'reflection', event: 'reflection.run', reason: wasAborted ? 'ABORTED' : undefined,
            data: { agent: 'reflection', profileId: pending.profileId || null, success: !wasAborted && !reflResult?.error, aborted: wasAborted, durationMs: reflectionMs, rounds: reflRounds, toolCallCount: reflToolCalls },
        });
        addDebugLog('debug', `[${pending.runId}] Stage timing (reflection): reflection=${reflectionMs}ms`, {
            runId: pending.runId, subsystem: 'pipeline', event: 'pipeline.timing',
            data: { phase: 'reflection', reflectionMs, totalMs: reflectionMs },
        });
    } catch (err) {
        recordHealthEvent('reflection', { status: 'fail', error: err.message || String(err) });
        addDebugLog('fail', `Reflection pass failed (non-fatal): ${err.message || err}`, {
            subsystem: 'reflection', event: 'reflection.run', reason: 'ERROR',
            data: { agent: 'reflection', profileId: pending.profileId || null, success: false, error: err.message || String(err), durationMs: Date.now() - reflectStart },
        });
    } finally {
        reflectionInFlight = false;
        // Identity check, not a blind null: a pass that somehow outlived its
        // successor must never drop the successor's abort handle and leave the
        // live pass uninterruptible.
        if (reflectionAbort === abortCtrl) reflectionAbort = null;

        internalCallDepth = Math.max(0, internalCallDepth - 1);
        updateStatus('idle');
    }
}

export function initPipeline() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    const isGroupChatSkip = (settings) => {
        const ctx = SillyTavern.getContext();
        if (!ctx.groupId && !ctx.selected_group) return false;
        if (!groupSkipToastShown) {
            groupSkipToastShown = true;
            addDebugLog('info', 'Injection skipped: group chats are not supported (show-once per chat)');
            if (settings.showToast && typeof toastr !== 'undefined') {
                toastr.info('BF Memory: group chats are not supported — memory injection skipped', 'BF Memory', { timeOut: 4000 });
            }
        }
        return true;
    };

    // The generation-type latch. ST emits this at the top of Generate(), before
    // either injection handler fires, with the type it was called with ('quiet',
    // 'impersonate', 'regenerate', 'swipe', 'continue', or undefined for a plain
    // reply). dryRun emits are ignored outright: ST fires a dry generation for
    // token counting, and letting it write the latch would hand the real emit that
    // follows a value belonging to a different call.
    //
    // Guarded on the event existing at all: `eventSource.on(undefined, fn)` binds
    // to a key nothing emits, which would silently take the quiet-prompt exclusion
    // out of service — and silence is the wrong failure for a guard.
    if (eventTypes.GENERATION_STARTED) {
        eventSource.on(eventTypes.GENERATION_STARTED, (type, _params, dryRun) => {
            if (dryRun) return;
            lastGenerationType = String(type || '') || null;
        });
    } else {
        addDebugLog('fail', 'GENERATION_STARTED is not in this SillyTavern build\'s event list — the lookup cannot tell a quiet/background prompt from a real turn and will run for both', {
            subsystem: 'agent3', event: 'lookup.skip', reason: 'NO_GENERATION_STARTED',
        });
    }

    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, async (data) => {
        try {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;
            if (data?.dryRun) return;
            // Consumed here, unconditionally and before any other early return, so
            // the latch can never carry a value into the NEXT generation.
            const genType = consumeGenerationType();
            // NO isInternalCall() guard here: internal agent calls dispatch via
            // CMRS or a direct backend fetch and never route through ST's generate
            // pipeline, so this event only fires for a GENUINE user generation.
            // Guarding silently dropped sheet injection AND lag-aware trim whenever
            // the user generated while a background run (e.g. the delayed
            // connection auto-retry, up to 10 min of tool loop) held
            // internalCallDepth raised.
            if (pipelineJustInjected) return;
            if (isGroupChatSkip(settings)) return;

            const rec = getMemorySheet(); 

            const arr = firstInjectableArray(data);
            const baselineInput = await countChatTokens(arr);

            // Trim is independent of sheet state: history stays bounded even when the
            // sheet is empty or still the seed skeleton (0 keeps trim off).
            const trimToLast = Math.max(0, Math.floor(settings.agent2ContextMessages || 0));

            // NEVER trim away an unprocessed message: when the memory pipeline is
            // behind the chat, widen the window to the lag depth so every settled-
            // but-unprocessed message stays in the storyteller's context (the sheet
            // does not cover it yet — cutting it would open a memory gap). As
            // extraction catches up the watermarks shrink the lag and the window
            // returns to the configured N on its own — no extra state.
            const { lag, count: lagCount } = computeCatchupLag();
            const effectiveTrim = trimToLast === 0 ? 0 : Math.max(trimToLast, lag);
            if (effectiveTrim !== trimToLast) {
                addDebugLog('debug', `History trim widened ${trimToLast} → ${effectiveTrim} (memory pipeline ${lagCount} message(s) behind)`, {
                    subsystem: 'writer', event: 'inject.lag_hold',
                    data: { configured: trimToLast, lag, effective: effectiveTrim },
                });
            }
            // THE ONLY AWAIT THAT HOLDS THE USER'S GENERATION. Off by default,
            // hard-deadlined when on, and it returns rec.text unchanged on every
            // skip/error/timeout path — so from here down "the sheet" means the
            // sheet plus whatever the lookup earned, and nothing below has to
            // know which of the two it got.
            const sheetText = await appendLookupBlock(rec.text, 'chat', genType);
            const lookupChars = sheetText.length - rec.text.length;

            const result = injectMemoryContext(data, sheetText, { trimToLast: effectiveTrim });
            // Ground-truth capture AFTER trim + injection, on every outcome — the
            // prompt is sent regardless of whether the sheet made it in.
            capturePostInjectionPrompt(arr, 'chat');
            if (!result.injected) {
                if (result.reason === 'EMPTY_SHEET') {
                    recordHealthEvent('injection', { status: 'empty', path: 'chat', trimmedCount: result.trimmedCount });
                    addDebugLog('info', `Memory sheet is empty — injection skipped (trim ${result.trimmedCount > 0 ? `removed ${result.trimmedCount} messages` : 'did not remove anything'})`, {
                        subsystem: 'writer', event: 'inject.empty_sheet',
                        data: { trimToLast, trimmedCount: result.trimmedCount },
                    });
                } else {
                    recordHealthEvent('injection', { status: 'fail', path: 'chat', reason: 'no usable prompt container' });
                    addDebugLog('fail', 'Memory sheet injection failed — no usable prompt container', {
                        subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
                    });
                }
                return;
            }
            if (rec.seeded) {
                addDebugLog('info', `Memory sheet is still the seed skeleton — injected as-is (trim ${result.trimmedCount > 0 ? `removed ${result.trimmedCount} messages` : 'did not remove anything'})`, {
                    subsystem: 'writer', event: 'inject.seeded',
                    data: { trimToLast, trimmedCount: result.trimmedCount },
                });
            }
            setInjectedGuard();
            // This sheet is now in the outgoing prompt. Arm only — the counters
            // are bumped after the reply lands, so nothing is added to the
            // critical path and nothing is credited to a prompt that was built
            // but never dispatched further than here.
            // Armed with the AUGMENTED text: a looked-up row reached the model
            // exactly like a sheet row did, and useCount/lastUsedAt are supposed
            // to mean "was injected", not "was on the standing sheet".
            armFactUsage(sheetText, 'chat');
            const actualInput = await countChatTokens(arr);
            const sheetTokens = await countTextTokens(sheetText);
            recordRunTokens({ baselineInput, actualInput, sheetTokens, path: 'chat' });
            // Post-injection snapshot: what was ACTUALLY sent after trim + sheet
            // (external capture tools hook this event BEFORE our injection and
            // show a misleading pre-injection prompt — this is the ground truth).
            const chatMsgs = Array.isArray(arr)
                ? arr.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length
                : undefined;
            recordHealthEvent('injection', {
                status: 'ok', path: 'chat', baselineInput, actualInput, sheetTokens,
                trimmedCount: result.trimmedCount, trimToLast, effectiveTrim, lag,
                totalMsgs: Array.isArray(arr) ? arr.length : undefined,
                chatMsgs,
                sheetPresent: !!String(sheetText || '').trim(),
                sheetChars: String(sheetText || '').length,
                lookupChars,
            });
            const trimTxt = effectiveTrim !== trimToLast
                ? `trim=${effectiveTrim} (widened from ${trimToLast}, lag ${lag})`
                : `trim=${trimToLast || 'off'}`;
            addDebugLog('pass', `Memory sheet injected (${sheetText.length} chars${rec.seeded ? ', seed' : ''}${lookupChars > 0 ? `, incl. ${lookupChars} looked up` : ''}; ${trimTxt}; tokens ${baselineInput} → ${actualInput})`, {
                subsystem: 'writer', event: 'inject.ok',
                data: { chars: sheetText.length, lookupChars, seeded: !!rec.seeded, trimToLast, effectiveTrim, lag, trimmedCount: result.trimmedCount, baselineInput, actualInput },
            });
        } catch (err) {

            recordHealthEvent('injection', { status: 'fail', path: 'chat', reason: err.message || String(err) });
            addDebugLog('fail', `Sheet injection failed (non-fatal): ${err.message || err}`);
        }
    });

    eventSource.on(eventTypes.GENERATE_AFTER_DATA, async (data, dryRun) => {
        try {
            if (dryRun) return;
            try {
                if (SillyTavern.getContext().mainApi === 'openai') return;
            } catch {  }
            // Consumed AFTER the mainApi return, not before: on a chat-completion
            // backend both handlers fire for the same generation, and taking the
            // latch here would leave CHAT_COMPLETION_PROMPT_READY — the handler
            // that actually runs the lookup on that backend — with nothing.
            const genType = consumeGenerationType();
            const settings = getSettings();
            if (!settings || !settings.enabled) return;
            // No isInternalCall() guard — same reasoning as the chat-completion
            // handler above: internal calls never fire this event, and guarding
            // dropped injection for user generations during background runs.
            if (pipelineJustInjected) return;
            if (isGroupChatSkip(settings)) return;

            const rec = getMemorySheet();
            // Same helper, same contract as the chat-completion path above — the
            // two handlers are mutually exclusive per generation, so this runs at
            // most once per turn.
            const sheetText = await appendLookupBlock(rec.text, 'text', genType);
            const lookupChars = sheetText.length - rec.text.length;
            const result = injectMemoryContext(data, sheetText);
            if (result.injected) {
                setInjectedGuard();
                // Same arming as the chat-completion path; the flush point in
                // MESSAGE_RECEIVED is shared, so usage accounting does not care
                // which of the two handlers got here.
                armFactUsage(sheetText, 'text');
                // Token recording (text-completion path). Injection stays first and
                // synchronous; counting only reads. No trim happens on this path,
                // so baseline (= prompt without the extension) is actual − sheet.
                let arr = null;
                let actualInput = 0;
                try {
                    arr = firstInjectableArray(data);
                    const promptStr = (!arr && typeof data?.prompt === 'string') ? data.prompt : null;
                    actualInput = arr ? await countChatTokens(arr) : await countTextTokens(promptStr);
                    const sheetTokens = await countTextTokens(sheetText);
                    if (actualInput > 0) {
                        recordRunTokens({ baselineInput: Math.max(0, actualInput - sheetTokens), actualInput, sheetTokens, path: 'text' });
                    }
                    // Ground-truth capture AFTER injection (string prompts become
                    // one pseudo-message; no trim exists on this path).
                    capturePostInjectionPrompt(arr, 'text', promptStr);
                } catch {  }
                // Post-injection snapshot with what this path has: message count
                // (when the payload is an array), sheet size, total tokens.
                recordHealthEvent('injection', {
                    status: 'ok', path: 'text',
                    totalMsgs: Array.isArray(arr) ? arr.length : undefined,
                    chatMsgs: Array.isArray(arr)
                        ? arr.filter(m => m && (m.role === 'user' || m.role === 'assistant')).length
                        : undefined,
                    sheetPresent: !!String(sheetText || '').trim(),
                    sheetChars: String(sheetText || '').length,
                    lookupChars,
                    actualInput,
                });
                addDebugLog('pass', `Memory sheet injected (text-completion, ${sheetText.length} chars${rec.seeded ? ', seed' : ''}${lookupChars > 0 ? `, incl. ${lookupChars} looked up` : ''})`, {
                    subsystem: 'writer', event: 'inject.ok',
                    data: { chars: sheetText.length, lookupChars, seeded: !!rec.seeded, path: 'text-completion' },
                });
            } else if (result.reason === 'EMPTY_SHEET') {
                recordHealthEvent('injection', { status: 'empty', path: 'text' });
                addDebugLog('info', 'Memory sheet is empty — injection skipped (text-completion, no trim on this path)', {
                    subsystem: 'writer', event: 'inject.empty_sheet',
                    data: { path: 'text-completion' },
                });
            } else {
                recordHealthEvent('injection', { status: 'fail', path: 'text', reason: 'no usable prompt container' });
                addDebugLog('fail', 'Memory sheet injection failed (text-completion) — no usable prompt container', {
                    subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
                });
            }
        } catch (err) {
            recordHealthEvent('injection', { status: 'fail', path: 'text', reason: err.message || String(err) });
            addDebugLog('fail', `Sheet injection failed (text-completion, non-fatal): ${err.message || err}`);
        }
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
        // Runs inside ST's awaited emit chain: keep this handler SYNCHRONOUS so
        // the reply finalizes and the send button re-activates immediately.
        clearInjectedGuard();

        pipelineCancelled = false;
        // A new message un-parks a second-consecutive-failure backlog: the run it
        // triggers gets a fresh auto-retry allowance.
        connectionFailureStreak = 0;
        updateStatus('idle');

        const shouldRecordOutput = runRecordedInput;
        runRecordedInput = false;

        // Detached memory stream — the chat is never blocked while memory runs.
        // Re-entrancy is guarded by memoryExtractionInFlight in runMemoryExtraction();
        // a run that is still in flight when the next reply arrives is coalesced
        // into a single chained catch-up retry, so runs never stack.
        (async () => {
            try {
                if (shouldRecordOutput) {
                    const ctx = SillyTavern.getContext();
                    const lastMsg = ctx.chat?.[ctx.chat.length - 1];
                    if (lastMsg && !lastMsg.is_user && lastMsg.mes) {
                        const n = await (ctx.getTokenCountAsync?.(lastMsg.mes) ?? 0);
                        setMainOutputTokens(n);
                    }
                }
            } catch {  }

            // The prompt has gone out and the reply is in. Credit the facts the
            // sheet carried BEFORE extraction runs, so this turn's writes and
            // this turn's cold-tiering already see them as used.
            await flushInjectedFactUsage();

            try {
                await runMemoryExtraction();
                maybeRunReflection();
            } catch (err) {
                addDebugLog('fail', `Settle extraction failed (non-fatal): ${err.message || err}`);
                toastPipelineError(`Memory update failed: ${err.message || err}`);
            } finally {
                consumePendingRun();
            }
        })();
    });

    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        cancelActiveRun('stopped');
        addDebugLog('info', 'Generation stopped — in-flight agent calls aborted, writes discarded', { subsystem: 'pipeline', event: 'pipeline.cancel', reason: 'STOPPED' });
    });

    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        addDebugLog('info', 'Message deleted — per-message watermarks remain the extraction source of truth');
    });

    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        // FIRST, before the await below: a reflection pass already in flight is
        // armed against the chat that just closed — its digest, its story window
        // and its repairs all describe that chat, and it holds database objects
        // invalidateDatabaseCache is about to orphan. Extraction gets the same
        // protection post-hoc (the captured-vs-live chat/character comparison
        // before the watermark+sheet commit); a reflection pass writes THROUGH
        // TOOLS as it goes, so post-hoc discard is not available to it and it
        // has to be stopped instead.
        abortReflectionPass('chat_changed');
        // Same reason, one pass earlier in the turn: a lookup in flight is
        // searching the store of the chat that just closed, and its refs would be
        // rendered against the newly loaded one. The post-await context check in
        // appendLookupBlock drops the result anyway; this stops the work.
        abortLookupPass('chat_changed');

        const { invalidateDatabaseCache } = await import('./database.js');
        invalidateDatabaseCache();

        internalCallDepth = 0;
        clearInjectedGuard();

        extractionRetryAfterBusy = false;
        cancelledRetryArmed = false;
        if (connectionRetryTimer) { clearTimeout(connectionRetryTimer); connectionRetryTimer = null; }
        connectionFailureStreak = 0;
        lastSentPrompt = null; // session/chat-scoped prompt proof — never crosses chats
        groupSkipToastShown = false;
        lastErrToastMsg = '';
        lastErrToastAt = 0;

        // No progress-counter reset here any more: it lives in chatMetadata and
        // is therefore already the new chat's own value. Resetting it was the
        // defect — twelve runs of progress died on every switch and reflection
        // never fired for anyone who switches chats.
        reflectionPending = null;
        // Armed against the chat that just closed; its refs would resolve against
        // the newly loaded character's store.
        pendingFactUsage = null;
        // The per-turn usage latch is keyed on chat+avatar, so a stale value could
        // not match here anyway — cleared so nothing chat-scoped outlives the chat.
        lastCountedTurn = null;
        // Same: the generation-type latch is consumed by the next injection
        // handler, and that handler must not read the closed chat's last type.
        lastGenerationType = null;
        // Drops the cached ref set (chat-scoped by construction) and re-arms the
        // deadline-strike latch: a new chat deserves its own three tries.
        resetLookupBreaker();
        // Chat indices are meaningless across chats — carrying this over would
        // size the next chat's story window against the previous chat's history.
        // The pass aborted at the top of this handler cannot resurrect the old
        // value: its rollback compare-and-swaps against this -1 AND against the
        // live chat id, and both tests fail here.
        lastReflectionChatIndex = -1;

        // Event-backed health rows must not carry the previous chat's results.
        clearHealthEvents();

        setPendingRun(null);
        endRun();
        hideWorkingIndicator();
        updateStatus('idle');

        addDebugLog('info', 'Chat changed - pipeline state reset');
    });

    console.log('[BFMemory] Pipeline initialized (redesign-v2: pure-code sheet injection + background Memory Agent)');
}
