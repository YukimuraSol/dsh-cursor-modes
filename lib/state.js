/**
 * The one merged mode state machine: `{ mode, pending, quota, notice, buildTodos }`.
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
 * and `multi.js` read it through {@link selectedMode} (and, for the commit step,
 * through {@link commitPending}); they never touch the Map themselves. That is
 * what keeps the four invariants below checkable.
 *
 * ## Invariants (blueprint §2.3)
 *
 * - **I1** every key of `state.pending` is a live session id, and
 *   `agent/pre-step` deletes the entry after consuming it — except when the step
 *   was rejected or the signal aborted, where the entry is kept for the next
 *   step (exactly what both legacy plugins did).
 * - **I2** {@link selectedMode} is the ONLY way to read the mode; no file may
 *   read `stateOf(session, 'mode').mode` directly.
 * - **I3** a pending entry equal to the logged mode is dropped on sight.
 * - **I4** `state.quota` is keyed by `Agent` only — HTTP routes have no agent and
 *   must not touch it.
 *
 * `state.mode` is NOT a second truth: it is the fallback read for paths with no
 * session context (startup self-checks, a `/status` route). Every judgement goes
 * through {@link selectedMode}.
 *
 * ## When a selection lands (口径 S1)
 *
 * Only when the user's own message is actually claimed: a step whose claimed
 * messages include a `source.kind === 'user'` prompt (or a Build click, which is
 * the user's decision wearing the card's stamp). A goal/schedule wake, a queued
 * message that was withdrawn, and a bare chip click all leave the selection
 * where it is. That is the whole rule; `state.pending` is demoted to "what the
 * mode control currently shows", not a queue of intents.
 *
 * @module dsh-cursor-modes/state
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendModeEvent, MODE_KEY } from './projection.js';
import { budgetBrief } from './multi-prompt.js';
import { capsOf, compositeNoticeText, isBuildClick, switchSummary } from './switch.js';
import { renderChecklist } from './prompts.js';

/** The one mode alphabet. Freezing it keeps a stray `push` from widening it. */
export const MODES = Object.freeze(['default', 'plan', 'multi']);

/**
 * A fresh state bag. One per `apply()`, handed to every `wire*` function.
 *
 * @returns {{
 *   mode: string,
 *   pending: Map<string, { mode: string, at: number, origin: 'command' | 'bridge' }>,
 *   quota: WeakMap<object, object>,
 *   notice: WeakMap<object, { switchId?: string, quotaId?: string, planId?: string }>,
 *   lastCommit: object | null,
 *   buildTodos: Map<string, { todos: Array<{ content: string, status: string }>, at: number }>
 * }}
 */
export function createState() {
	return {
		// ① Fallback read only — never a judgement source (see the module docblock).
		mode: 'default',
		// ② key = session.id (a string): the HTTP routes hold a sessionId, not a
		//    Session object, so a WeakMap<Session> cannot be written from there.
		pending: new Map(),
		// ③ Tool-call quota, per EXACT Agent: a second agent on the same session must
		//    not share or clear another's stretch.
		quota: new WeakMap(),
		// ④ Notice ids this plugin put in an inbox, so a stale one can be withdrawn.
		notice: new WeakMap(),
		// ⑤ Diagnostics only: the last mode this plugin committed at a step start.
		//    The switch route reports it; nothing reads it as a decision source.
		lastCommit: null,
		// ⑥ The checklist a DEFAULT Build click approved, waiting for the step that
		//    runs inside the turn the click opened. key = session.id, exactly like ②.
		//    A "Build in Multi" click stages nothing: the work (and its list) belongs
		//    to the workers, so the conversation keeps only the notice.
		buildTodos: new Map()
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
 * Mode in force for a session. Pending wins over logged so a switch that has not
 * been projected yet still gates (and stops gating) on time — the same
 * precedence the mode control and both policy sections use.
 *
 * @param {object} host
 * @param {ReturnType<typeof createState>} state
 * @param {object} session
 * @returns {string}
 */
export function selectedMode(host, state, session) {
	return state.pending.get(session?.id)?.mode ?? loggedMode(host, session);
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
 * `'quota'` (the multi-mode budget notice), `'plan'` (a plan-mode notice), or
 * `undefined` for anything this plugin must leave alone — including a Build
 * click, which is a real instruction, not a mode transition.
 *
 * NOTE: the return value is a CATEGORY, never a message id. An inbox sweep
 * needs {@link dropStaleNotices}, which reads `message.id` itself.
 *
 * @param {object} message
 * @returns {'switch' | 'quota' | 'plan' | undefined}
 */
export function noticeIdOf(message) {
	const src = message?.source;
	if (!src || src.form !== 'notice' || !NOTICE_KINDS.has(src.kind)) return undefined;
	const summary = String(src.summary ?? '');
	if (/^The user clicked Build (?:in Multi|in Default)\.$/.test(summary)) return undefined; // build 点击不是模式切换
	if (/^The user switched this session/.test(summary)) return 'switch';
	if (/edit window|quota|edits/i.test(summary)) return 'quota';
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

	const text = compositeNoticeText(from, pending.mode, capsOf(host, agent));
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
