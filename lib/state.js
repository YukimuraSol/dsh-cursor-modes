/**
 * The one merged mode state machine: `{ mode, pending, notice, buildTodos }`.
 *
 * Three legacy plugins each kept its own copy of the same idea:
 *
 *   dsh-cursor-plan   const state = { pendingIntents: new WeakMap() }   (plan)
 *   dsh-modes         const state = { pendingIntents: new WeakMap() }   (multi)
 *   dsh-mode-switch   const staged = new Map()                          (sessionId)
 *
 * This module is the single server-side owner of all four fields (blueprint
 * §2.1/§2.2). The value domain is one alphabet — `'default' | 'plan' | 'multi'` —
 * so no call site mixes `cursorPlan`/`cursorMulti` ids with mode names any more.
 *
 * ## Boundary discipline (blueprint §1.5)
 *
 * **`state.js` is the ONLY file allowed to write `state.pending`.** `plan.js`
 * and `multi.js` reach it only through {@link commitPending}; they never touch
 * the Map themselves. `makePendingRoutes` (`routes.js`) is the one documented
 * exception: an HTTP route holds a session id and no `Agent`, so it cannot go
 * through an API that only `state.js` may call. That is what keeps the four
 * invariants below checkable.
 *
 * ## Invariants (blueprint §2.3; rev. 2026-11-03, 口径 S1)
 *
 * - **I1** every key of `state.pending` is a session **id** (a string), never a
 *   `Session`/`Agent` object — `/stage` can only check that it is a non-empty
 *   string, so an id with no live session leaves an inert entry nothing consumes.
 *   The ONLY reader is `agent/pre-step` → {@link commitPending}, which deletes
 *   the entry on the step it commits it. A step that delivered no user message
 *   (S1), a rejected step and an aborted signal leave the entry in place for a
 *   later step; a failed append does NOT — the entry is deleted before the
 *   append is attempted, so a refused append drops the staged switch instead of
 *   retrying it forever (`self-check-runtime.mjs` pins that; the previous wording
 *   here claimed the opposite).
 * - **I2** {@link selectedMode} is the ONLY way to read the mode in force, and
 *   since 2026-11-03 it is exactly the LOGGED mode — it never consults
 *   `state.pending`, so a staged selection cannot gate or re-label anything on
 *   its own. No file may read `stateOf(session, 'mode').mode` directly.
 * - **I3** a pending entry equal to the logged mode is dropped without an
 *   append: `commitPending` deletes the entry before it compares, so an equal
 *   selection dies silently on its landing step. Until that step the entry just
 *   sits in the map — nothing reads it (I2), so an equal stage is inert even
 *   before it is dropped.
 * `state.mode` is NOT a second truth: it is the fallback read for paths with no
 * session context (startup self-checks, a `/status` route). Every judgement goes
 * through {@link selectedMode}.
 *
 * ## When a selection lands (口径 S1, rev. 2026-11-03)
 *
 * Clicking the mode control is NOT a mode change. The chip only *stages* a
 * selection; no judgement, no gate and no prompt text moves until the user
 * actually sends a message.
 *
 * Landing requires a step whose claimed messages include a
 * `source.kind === 'user'` prompt (or a Build click, which is the user's
 * decision wearing the card's stamp). A goal/schedule wake, a queued message
 * that was withdrawn, a subagent report and a bare chip click all leave the
 * selection where it is — and, until it lands, {@link selectedMode} keeps
 * answering the OLD mode.
 *
 * Accepted cost, by decision (2026-11-03): a switch staged mid-turn does not
 * loosen or tighten a gate until the next send; the turn already open keeps the
 * mode it opened with.
 *
 * `projection.js`'s `wanted`/`pending` view (`{ mode, pending }`) is a DIFFERENT
 * thing and stays untouched: it is the chip's "staged / active" display, folded
 * from the command events, and no judgement reads it.
 *
 * @module dsh-cursor-modes/state
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendModeEvent, MODE_KEY } from './projection.js';
import { MULTI_ID } from './multi-prompt.js';
import { compositeNoticeText, isBuildClick, switchSummary } from './switch.js';
import { renderChecklist } from './prompts.js';

/** The one mode alphabet. Freezing it keeps a stray `push` from widening it. */
export const MODES = Object.freeze(['default', 'plan', 'multi']);

/**
 * A fresh state bag. One per `apply()`, handed to every `wire*` function.
 *
 * @returns {{
 *   mode: string,
 *   pending: Map<string, { mode: string, at: number, origin: 'command' | 'bridge' }>,
 *   notice: WeakMap<object, { switchId?: string, planId?: string }>,
 *   lastCommit: object | null,
 *   buildTodos: Map<string, { todos: Array<{ content: string, status: string }>, at: number }>,
 *   adopted: Map<string, Set<string>>,
 *   published: Map<string, number>,
 *   lastT0: number
 * }}
 */
export function createState() {
	return {
		// ① Fallback read only — never a judgement source (see the module docblock).
		mode: 'default',
		// ② key = session.id (a string): the HTTP routes hold a sessionId, not a
		//    Session object, so a WeakMap<Session> cannot be written from there.
		pending: new Map(),
		// ③ Notice ids this plugin put in an inbox, so a stale one can be withdrawn.
		notice: new WeakMap(),
		// ⑤ Diagnostics only: the last mode this plugin committed at a step start.
		//    The switch route reports it; nothing reads it as a decision source.
		lastCommit: null,
		// ⑥ The checklist a DEFAULT Build click approved, waiting for the step that
		//    runs inside the turn the click opened. key = session.id, exactly like ②.
		//    A "Build in Multi" click stages nothing: the work (and its list) belongs
		//    to the workers, so the conversation keeps only the notice.
		buildTodos: new Map(),
		// ⑦ Plan-doc mount (plan.js). `adopted` is the only gate: `plans/` is shared by
		//    every session and the file name/frontmatter carry no session identity, so
		//    an mtime window alone could mount another session's plan.
		adopted: new Map(),
		// ⑧ path -> the mtime of the content last published as a plandoc. One record
		//    per new content, whichever call produced it.
		published: new Map(),
		// ⑨ Date.now() of the tool call now in flight (see plan.js notePlanCallStart).
		lastT0: 0
	};
}

/**
 * Current logged mode from the merged projection. Throws on the first access
 * when the projection is not mounted, so a mis-ordered mount fails loudly
 * instead of silently reading `undefined` as a mode.
 *
 * @param {object} host context carrying `sessionProjections`
 * @param {object} session
 * @returns {string} `'default' | 'plan' | 'multi'`
 */
export function loggedMode(host, session) {
	const state = host.sessionProjections.stateOf(session, MODE_KEY);
	if (state === undefined) throw new Error('dsh-cursor-modes requires the mode session projection');
	return state.mode;
}

/**
 * Mode in force for a session: the LOGGED mode, full stop.
 *
 * Since 2026-11-03 (口径 S1) a staged selection has no effect of its own. The
 * mode control only queues it, and `agent/pre-step` → {@link commitPending}
 * lands it on the next step that claims the user's own message. Reading
 * `state.pending` here — which this function did until then — made a bare chip
 * click flip the gates, the `<当前模式>` marker and both policy sections before
 * the user had sent anything, so a subagent report or a schedule wake in that
 * window was judged, and prompted, as the not-yet-chosen mode.
 *
 * The `state` argument is deliberately kept and unused: every call site (the
 * marker, `tools/pre-execute`, the plan gate) keeps reading through this ONE
 * function, which is what I2 asks for.
 *
 * @param {object} host
 * @param {ReturnType<typeof createState>} state unused since 2026-11-03 (I1: pending is commit's inbox)
 * @param {object} session
 * @returns {string}
 */
export function selectedMode(host, state, session) {
	return loggedMode(host, session);
}

/**
 * Withdraw every not-yet-delivered notice this plugin owns from the agent's
 * inbox. The plugin no longer narrates a switch through the inbox (the one
 * notice rides the step's own messages), so the only thing left to sweep is a
 * line an older revision left pending in a live session — one scan, and it can
 * only remove this plugin's own lines.
 *
 * @param {object} agent
 */
export function dropStaleNotices(agent) {
	for (const message of [...agent.inbox.nextStep]) {
		// noticeIdOf classifies; the inbox is keyed by MessageId, so the sweep
		// must pass message.id. Passing the classification removed nothing.
		if (noticeIdOf(message) !== undefined && message.id != null) agent.inbox.remove(message.id);
	}
}

/**
 * Notice kinds the three legacy plugins produced, plus this plugin's own. A v3
 * notice carries a bare kind, a migrated one carries `plugin:<name>`; both stay
 * matchable so an old session's pending line is still swept.
 */
const NOTICE_KINDS = new Set(['cursor-plan', 'modes', 'dsh-mode-switch', 'dsh-cursor-modes',
	'plugin+cursor-plan', 'plugin+modes', 'plugin:cursor-plan', 'plugin:modes', 'plugin:cursor-modes']);

/**
 * Classify one inbox message: `'switch'` (the composite switch narration),
 * `'plan'` (a plan-mode notice), or `undefined` for anything this plugin must
 * leave alone — including a Build click, which is a real instruction, not a mode
 * transition.
 *
 * NOTE: the return value is a CATEGORY, never a message id. An inbox sweep
 * needs {@link dropStaleNotices}, which reads `message.id` itself.
 *
 * @param {object} message
 * @returns {'switch' | 'plan' | undefined}
 */
export function noticeIdOf(message) {
	const src = message?.source;
	if (!src || src.form !== 'notice' || !NOTICE_KINDS.has(src.kind)) return undefined;
	const summary = String(src.summary ?? '');
	if (/^The user clicked Build (?:in Multi|in Default)\.$/.test(summary)) return undefined; // build 点击不是模式切换
	if (/^The user switched this session/.test(summary)) return 'switch';
	return 'plan';
}

/**
 * Whether this step actually delivered the user's own words — the only moment a
 * staged selection may land (口径 S1).
 *
 * `source.kind === 'user'` is what the composer stamps on a real prompt; a
 * message with no `source` at all is admitted for the same reason the retired
 * decision-point test admitted it (no producer emits one, but if one ever does
 * it is the user). A Build click is admitted by its own stamp: the user pressed
 * the button, and the card's message is that decision's only carrier.
 *
 * Everything else is a wake — `goal`, `schedule`, `agent-message`,
 * `subagent-settled`, `team-message`, `tool-jobs`, `runtime-context` … — and
 * must never consume a selection.
 *
 * @param {object} message one claimed message.
 * @returns {boolean}
 */
export function isUserDelivery(message) {
	if (message?.source === undefined) return true;
	if (message.source.kind === 'user') return true;
	return isBuildClick(message);
}

/**
 * Commit a mode selected while the turn was open. The append is what makes the
 * switch visible to resume and fork; without it the pending intent would sit in
 * the map forever and keep overriding the logged mode.
 *
 * The append is a PLUGIN RECORD (`plugin:cursormodes/state`, `ignorable: true`),
 * not `session.append` with a bare type: the record is what lets a host with
 * this plugin uninstalled keep the log readable. See projection.js.
 *
 * S1: with `requireUserMessage`, a step that delivered no user message returns
 * untouched — the entry stays, nothing is appended, nothing is announced. A
 * rejected step or an aborted signal keeps the entry too (I1).
 *
 * On a real commit this returns a NEW decision carrying the one switch notice,
 * so the model reads it in the very step the mode changed. A Build click is the
 * exception: the card's own message already says which button was pressed, so
 * the composite sentence would only repeat it.
 *
 * @param {object} host
 * @param {ReturnType<typeof createState>} state
 * @param {{ session: object }} agent
 * @param {{ kind?: string, messages?: object[] }} decision the decision from `next()`
 * @param {{ aborted?: boolean }} [signal]
 * @param {{ requireUserMessage?: boolean }} [options]
 * @returns the decision to hand on, possibly with the switch notice appended.
 */
export function commitPending(host, state, agent, decision, signal, options = {}) {
	const session = agent.session;
	const id = session?.id;
	const pending = state.pending.get(id);
	if (pending === undefined) return decision;
	if (decision?.kind === 'reject' || signal?.aborted === true) return decision;

	const messages = Array.isArray(decision?.messages) ? decision.messages : [];
	const delivered = messages.filter((message) => isUserDelivery(message));
	if (options.requireUserMessage === true && delivered.length === 0) return decision;

	state.pending.delete(id);
	const from = loggedMode(host, session);
	if (pending.mode === from) return decision;
	try {
		appendModeEvent(session, pending.mode);
	} catch (error) {
		host.logger.warn('dsh-cursor-modes: failed to append the selected mode at step start: %o', error);
		return decision;
	}
	state.lastCommit = { sessionId: id, from, to: pending.mode, at: Date.now() };
	dropStaleNotices(agent);

	// A step whose only user delivery is a Build click: the card's message is the
	// instruction, not a transition to announce.
	const buildOnly = delivered.length > 0
		&& delivered.every((message) => isBuildClick(message))
		&& !delivered.some((message) => message?.source === undefined || message.source.kind === 'user');
	if (buildOnly) return decision;

	const text = compositeNoticeText(from, pending.mode);
	if (text === undefined) return decision;
	const notice = createUserMessage({
		content: [{ type: 'text', text }],
		// `summary` is the one line the conversation can show for a notice; the body
		// stays the complete sentence the model reads.
		source: { kind: 'dsh-cursor-modes', form: 'notice', summary: switchSummary(pending.mode) }
	});
	return { ...decision, messages: [...messages, notice] };
}

/**
 * Stage the checklist a DEFAULT Build click approved, keyed by session id.
 *
 * The build route used to append `todo/write` itself, and a Build click lands
 * while the session is idle — between the previous `turn/end` and the next
 * `turn/start`. The kernel's `todos` projection returns null on `turn/start`
 * (`@deepseek-ai/dsh-tool-todo`), so that append was wiped by the very turn it
 * was meant for: the dock showed the list for one frame and then nothing.
 *
 * Staging holds the list until {@link commitBuildTodos} can write it inside the
 * turn the click opened — the window `dsh-subagent`'s `attachInitialTodos` uses
 * for a child's initial list, for the same reason.
 *
 * Only "Build in Default" stages: that build is the session's own agent doing the
 * work, so the list belongs in this conversation. "Build in Multi" hands the work
 * to workers, which receive their slice through the `subagent` tool's own
 * `todos` argument; this conversation keeps the notice and no dock.
 *
 * One entry per session: a second click before that step runs replaces the first
 * (same plan, same checklist). Memory only — a restart loses it, and that turn
 * loses its list with it.
 *
 * @param {ReturnType<typeof createState>} state
 * @param {string} sessionId
 * @param {Array<{ content: string, status: string }>} todos already normalized
 */
export function stageBuildTodos(state, sessionId, todos) {
	state.buildTodos.set(sessionId, { todos, at: Date.now() });
}

/**
 * Write a staged checklist at the one moment it survives: `agent/pre-step` said
 * `enter`, so the loop has already appended this turn's `turn/start`. Called
 * from the plugin's single pre-step, after both mode commits.
 *
 * Deleted on sight, so the list is written exactly once and never replayed on a
 * later step of the same turn; the next turn is not re-seeded (per-turn
 * semantics stay the kernel's). A rejected step keeps the entry for the next
 * one, the same rule `state.pending` follows (I1).
 *
 * @param {object} host context carrying `logger`
 * @param {ReturnType<typeof createState>} state
 * @param {{ session: { id: string, append: Function } }} agent
 * @param {{ kind?: string }} decision the decision `next()` returned
 * @returns the decision, untouched (the append is a plain side effect)
 */
export function commitBuildTodos(host, state, agent, decision) {
	const id = agent?.session?.id;
	if (typeof id !== 'string' || decision?.kind !== 'enter') return decision;
	const staged = state.buildTodos.get(id);
	if (staged === undefined) return decision;
	state.buildTodos.delete(id);
	try {
		agent.session.append('todo/write', {
			todos: staged.todos.map(({ content, status }) => ({ content, status }))
		});
	} catch (error) {
		host.logger.warn('dsh-cursor-modes: failed to append the approved checklist at step start: %o', error);
	}
	// The checklist reaches the MODEL exactly once, here, as the turn's opening
	// context — never as a live mirror of the projection. Re-rendering it every
	// step would append a fresh runtime-context snapshot on every edit; after this
	// one notice the model is on its own and uses `todo_write` like any session.
	const text = renderChecklist(staged.todos);
	if (text === '') return decision;
	const checklist = createUserMessage({
		content: [{ type: 'text', text }],
		source: { kind: 'dsh-cursor-modes', form: 'notice', summary: 'Approved checklist' }
	});
	const messages = Array.isArray(decision?.messages) ? decision.messages : [];
	return { ...decision, messages: [...messages, checklist] };
}

/** The word the rules use for a mode id: `multi` is persisted, `multitask` is read. */
const MARKER_WORDS = { multi: 'multitask' };

/** Source kind stamped on the marker message, so detection needs no text parse. */
const MARKER_SOURCE_KIND = 'dsh-cursor-modes';

/** The one line the mode rules read, for a mode id. */
export function modeMarkerText(mode) {
	return `<当前模式>${MARKER_WORDS[mode] ?? mode}</当前模式>`;
}

/** The mode word one message carries, or `undefined` when it is not a marker. */
function markerWordOf(message) {
	if (message?.source?.kind !== MARKER_SOURCE_KIND) return undefined;
	const text = (message.content ?? []).map((block) => block?.text ?? '').join('').trim();
	const found = /^<当前模式>([^<]+)<\/当前模式>$/.exec(text);
	return found?.[1];
}

/**
 * The messages the NEXT request will carry. `deriveMessages` is the session's
 * derived history (compaction replaces nodes, so a folded-away marker is gone
 * from here too), which is exactly the check below needs.
 */
function historyOf(session) {
	try {
		return typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
	} catch {
		return [];
	}
}

/**
 * The marker word already sitting after the latest user message, or `undefined`
 * when there is none. Scanning backwards stops at the latest user delivery: a
 * marker BEFORE the latest user message belongs to an older instruction.
 */
function markerAfterLatestUser(history) {
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const word = markerWordOf(history[index]);
		if (word !== undefined) return word;
		if (isUserDelivery(history[index])) return undefined;
	}
	return undefined;
}

/**
 * Guarantee that the latest user message is followed by one
 * `<当前模式>X</当前模式>` line naming the mode now in force, appending one only
 * when it is missing or disagrees.
 *
 * Called from the plugin's single `agent/pre-step`, after both mode commits, so
 * the mode read here is the one this step runs in. Appending on every step would
 * put a line in every tool loop; the history check is what keeps this to one line
 * per user message: a step that delivered no user message already has its marker,
 * and only compaction (which folds the marker away) or a mode that moved without
 * a fresh delivery can bring the append back.
 *
 * @param {object} host context carrying `sessionProjections`
 * @param {ReturnType<typeof createState>} state
 * @param {{ session: object }} agent
 * @param {{ kind?: string, messages?: object[] }} decision the decision `next()` returned
 * @returns the decision to hand on, possibly with the marker appended last
 */
export function ensureModeMarker(host, state, agent, decision) {
	if (decision?.kind !== 'enter') return decision;
	const session = agent?.session;
	if (session === undefined || typeof session.id !== 'string') return decision;
	const messages = Array.isArray(decision.messages) ? decision.messages : [];
	const mode = selectedMode(host, state, session);
	const word = MARKER_WORDS[mode] ?? mode;
	if (messages.some((message) => markerWordOf(message) === word)) return decision;
	const delivered = messages.some((message) => isUserDelivery(message));
	if (!delivered && markerAfterLatestUser(historyOf(session)) === word) return decision;
	const marker = createUserMessage({
		content: [{ type: 'text', text: modeMarkerText(mode) }],
		// No `form`: this is a line the rules read, not a notice the GUI shows, and
		// dropStaleNotices only classifies `form: 'notice'`.
		source: { kind: MARKER_SOURCE_KIND }
	});
	return { ...decision, messages: [...messages, marker] };
}
