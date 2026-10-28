/**
 * Multi-mode tool-call quota gate. Framework-free (no DSH import), so
 * `self-check-gate.mjs` exercises it directly without booting a harness.
 *
 * The quota is charged per CALL, and the only thing that is free is a call that
 * merely decides WHO does the work (delegation, team, and the quota request
 * itself). Everything else — reads, searches, plans, writes, shell, MCP bridges
 * — spends one. `run_code` is the PTC carrier, not an edit tool: the model
 * calls it to reach other tools, so charging the carrier AND its dispatch would
 * double-count and, worse, would refuse the carrier itself once the quota ran
 * out, which made delegation impossible exactly when it was the way out.
 *
 * ## Deferred charging (PTC)
 *
 * 1. `run_code`'s pre-execute charges nothing and records a provisional entry
 *    for its serial-call root, then lets it run.
 * 2. The first sub-call under that root decides: a delegation tool marks the
 *    root as delegation-only and stays free; anything else marks it spent and
 *    charges one unit right there (a spent window refuses THAT sub-call, not the
 *    whole `run_code`, so the program keeps running).
 * 3. `run_code`'s post-execute settles: already charged → nothing more; only
 *    delegation → free; no sub-call at all (pure computation) → charge one.
 *    That last charge is booked even past the quota (`spent` may exceed it) —
 *    it is a correction, not a decision, so it never refuses.
 *
 * Outside PTC there is no carrier: every call is judged on its own name.
 *
 * Cycle = the agent's turn number. Only the wakes a human or a delegated
 * agent causes clear what the previous cycle spent; `goal` / `schedule`
 * open a new turn but deliberately do not, so a timer cannot buy a free
 * stretch.
 *
 * ponytail: the reset set is a whitelist of real `source.kind` values, so a
 * wake this list does not name keeps the quota — the fail-safe direction. The
 * ceiling is that a new wake kind added to the host union later would silently
 * inherit "does not reset"; the upgrade path is to re-run
 * `self-check-gate.mjs`, which pins the exact set both ways.
 *
 * @module dsh-modes/gate
 */

import { MULTI_ID, budgetBrief } from './multi-prompt.js';

/** The PTC transport's tool name. A carrier: it never spends by itself. */
export const RUN_CODE = 'run_code';

/**
 * Tools whose calls spend nothing. The rule is not "read-only": it is "this call
 * only decides who does the work". `request_more_edits` MUST be here — its own
 * precondition is a spent quota, which is exactly the range a charged call is
 * refused in, so charging it would close the only way out.
 *
 * One list covers both sources: `send_message` / `list_agents` /
 * `interrupt_agent` and the `team_*` names are shipped by the subagent package
 * and by the Agent Teams package under the same names.
 */
export const EXEMPT_TOOLS = new Set([
	'subagent',
	'subagent_fork',
	'send_message',
	'list_agents',
	'interrupt_agent',
	'spawn_teammate',
	'wait_agent',
	'team_task_create',
	'team_task_list',
	'team_task_get',
	'team_task_update',
	'request_more_edits'
]);

/**
 * Wakes that reset the counter and drop a granted surplus.
 *
 * `agent-message` is the one a background subagent's report actually arrives
 * as: the harness claims that relayed message to open the new turn, while the
 * `subagent-settled` notice that follows is spliced into the *running* turn and
 * consumed inside it, so it never reaches `rollTurn` as a wake. Evidence:
 * `dsh-agent-loop/lib/index.js:106` emits the claim for whatever was claimed,
 * and `dsh-subagent/lib/types/continuation-messages.js:8` is the only producer
 * of `kind: 'agent-message'`.
 *
 * `subagent-settled` stays listed for the settlement that *does* open a turn
 * (the parent was idle, so `sendWaking` queues rather than steers —
 * `dsh-subagent/lib/types/continuation-activation.js:681`).
 *
 * `team-message` is a teammate's report: the Agent Teams plugin stamps it
 * (`dsh-experimental-agent-team/lib/index.js:913`, declared in its
 * `lib/types/types.d.ts:114`), and delivery relays it through the same
 * `submitAdmitted` path, so an idle Lead is steered into a fresh turn
 * (`dsh-agent-loop/lib/index.js:809`). That is the same event as a subagent
 * coming back — someone delegated to has returned — so it resets too.
 */
export const RESET_SOURCES = new Set(['user', 'agent-message', 'subagent-settled', 'team-message']);

/**
 * Wakes that must NOT reset the counter. Named so a later edit adding one of
 * them to `RESET_SOURCES` fails the self-check instead of quietly letting a
 * timer buy a stretch.
 */
export const NON_RESET_SOURCES = new Set(['goal', 'schedule']);

/** Base quota per stretch. */
export const LIMIT = 10;

/** Surplus added per approval. */
export const GRANT = 5;

/**
 * Serial-call identity. Every PTC sub-call inherits its parent's
 * `rootCallId`, so one `run_code` that dispatches several charged calls
 * shares one root — and one root is charged at most once.
 */
export function rootOf(exec) {
	return exec.rootCallId ?? exec.callId ?? exec.token ?? exec.name;
}

/**
 * Fresh per-agent state. `seen` holds the serial-call roots already charged
 * this turn, which is the counter itself — a Set is the shortest thing that
 * de-duplicates a PTC fan-out for free. `provisional` holds the `run_code`
 * roots that are still being dispatched. `warned` is the exhaustion latch: set
 * by the charge that spends the quota's last unit, cleared by a refresh and by
 * every grant, so each exhaustion point warns exactly once.
 */
export function initState() {
	return {
		seen: new Set(),
		provisional: new Map(),
		extra: 0,
		turn: -1,
		sourceKind: undefined,
		wake: undefined,
		pendingNotice: undefined,
		pendingNoticeText: undefined,
		warned: false
	};
}

/** Total quota available this turn. */
export function quotaOf(state, limit = LIMIT) {
	return limit + state.extra;
}

/** Calls already charged this turn. */
export function spentOf(state) {
	return state.seen.size;
}

/**
 * Fold one `agent/inbox/claimed` wake into the state. The harness already
 * splits wake from steer on `agent.status === 'idle'`: a claim while idle is a
 * follow-up that opens a new turn, a claim while running is an in-turn steer on
 * the same turn. `agent/inbox/inserted` cannot tell those apart.
 *
 * The wake is recorded, not applied: {@link rollTurn} is the single place that
 * moves the turn and decides whether it clears the quota, so the pre-step and
 * pre-execute hooks cannot double-apply it.
 */
export function observeWake(state, { turn, sourceKind }) {
	state.wake = { turn, sourceKind };
}

/** Apply a pending wake, if one has arrived. Returns true when it reset. */
export function applyWake(state) {
	if (state.wake === undefined) return false;
	const { turn, sourceKind } = state.wake;
	return rollTurn(state, turn, sourceKind);
}

/**
 * Apply the turn boundary once. Returns true when it cleared the quota.
 *
 * ponytail: a resume or hot reload has no claimed event, so callers also feed
 * the `turnBoundary` projection here; the ceiling is that a session reloaded
 * mid-turn keeps its in-memory count, which is the safe direction.
 */
export function rollTurn(state, turn, sourceKind = state.sourceKind) {
	if (typeof turn !== 'number' || turn <= 0 || turn === state.turn) return false;
	state.turn = turn;
	if (sourceKind !== undefined) state.sourceKind = sourceKind;
	state.wake = undefined;
	if (!RESET_SOURCES.has(state.sourceKind)) return false;
	resetQuota(state);
	return true;
}

/**
 * Clear the spent counter, the granted surplus, any undelivered notice, and the
 * exhaustion latch — a refreshed stretch owes both of its notices again.
 */
export function resetQuota(state) {
	state.seen.clear();
	state.provisional.clear();
	state.extra = 0;
	state.pendingNotice = undefined;
	state.pendingNoticeText = undefined;
	state.warned = false;
}

/**
 * Grant surplus, and re-arm the exhaustion notice so the *new* quota's last unit
 * warns again. The wake brief is deliberately not re-armed here: it is not a
 * refresh, and {@link rollTurn} is its only producer.
 * ponytail: the surplus rides the rest of the current turn plus any turn a
 * timer opens (only a human wake drops it), which is what "until you finish
 * or a person comes back" means.
 */
export function grantExtra(state, amount = GRANT) {
	state.extra += amount;
	state.warned = false;
}

/**
 * Charge one serial-call root, or refuse it when the stretch is spent.
 *
 * @param {object} state
 * @param {string} root
 * @param {number} quota
 * @returns {{ kind: 'allow' } | { kind: 'notify', root: string, text: string } | { kind: 'deny', reason: string }}
 */
function chargeRoot(state, root, quota) {
	if (state.seen.has(root)) return { kind: 'allow' };
	if (state.seen.size < quota) {
		state.seen.add(root);
		if (state.seen.size === quota && !state.warned) {
			state.warned = true;
			state.pendingNotice = root;
			state.pendingNoticeText = blockedText();
			return { kind: 'notify', root, text: state.pendingNoticeText };
		}
		return { kind: 'allow' };
	}
	return { kind: 'deny', reason: denyReason() };
}

/**
 * Decide one tool call.
 *
 * - `null` — not this gate's business (wrong mode).
 * - `{ kind: 'allow' }` — let it run, saying nothing (free, already charged,
 *   or a `run_code` whose charge is deferred).
 * - `{ kind: 'notify', root, text }` — charge it, let it run, and attach `text`
 *   to its result. The only notice on this path is {@link blockedText}, on the
 *   call that spends the quota's last unit; `warned` latches it and every grant
 *   re-arms it, so each exhaustion point warns once.
 * - `{ kind: 'deny', reason }` — the stretch is gone; the reason repeats the
 *   full rules, so a model that never saw a notice still reads the way out.
 *
 * A refused call is never notified: the refusal *is* the message.
 */
export function decideEdit(exec, { mode, state, limit = LIMIT }) {
	if (mode !== MULTI_ID) return null;

	const root = rootOf(exec);
	const quota = quotaOf(state, limit);

	// A sub-call of a run_code that is still open: the carrier's root owns the
	// charge, so the first non-exempt dispatch spends it and every later one rides
	// along. A refusal here refuses only this sub-call.
	const open = state.provisional.get(root);
	if (open !== undefined) {
		if (open.charged) return { kind: 'allow' };
		if (EXEMPT_TOOLS.has(exec.name)) {
			open.sawDelegate = true;
			return { kind: 'allow' };
		}
		open.sawOther = true;
		const verdict = chargeRoot(state, root, quota);
		if (verdict.kind !== 'deny') open.charged = true;
		return verdict;
	}

	if (state.seen.has(root)) return { kind: 'allow' };

	// The carrier itself: defer. `settleRoot` decides what it cost.
	if (exec.name === RUN_CODE) {
		state.provisional.set(root, { charged: false, sawDelegate: false, sawOther: false });
		return { kind: 'allow' };
	}

	if (EXEMPT_TOOLS.has(exec.name)) return { kind: 'allow' };

	return chargeRoot(state, root, quota);
}

/**
 * Settle one `run_code`'s deferred charge, at its post-execute.
 *
 * - already charged by a sub-call, or a sub-call was refused: nothing to do;
 * - delegation only: free — that is the whole point of the exemption;
 * - no sub-call at all (pure computation): charge one. Booked even past the
 *   quota, because the call already ran; it must not turn into a refusal.
 *
 * @param {object} state
 * @param {object} exec the settled call
 * @param {{ limit?: number }} [options]
 * @returns {{ kind: 'none' | 'settled' | 'free' | 'charge' | 'notify', text?: string }}
 */
export function settleRoot(state, exec, { limit = LIMIT } = {}) {
	const root = rootOf(exec);
	const open = state.provisional.get(root);
	if (open === undefined) return { kind: 'none' };
	state.provisional.delete(root);
	if (open.charged || open.sawOther) return { kind: 'settled' };
	if (open.sawDelegate) return { kind: 'free' };
	const verdict = chargeRoot(state, root, quotaOf(state, limit));
	if (verdict.kind === 'deny') {
		// The call already ran: record it without refusing anything.
		state.seen.add(root);
		return { kind: 'charge' };
	}
	return verdict.kind === 'notify' ? { kind: 'notify', text: verdict.text } : { kind: 'charge' };
}

/**
 * Whether this execution is the one a notice is waiting on, i.e. the call that
 * spent the stretch's last unit.
 */
export function takesNotice(state, exec) {
	return state.pendingNotice !== undefined && state.pendingNotice === rootOf(exec);
}

/**
 * The copy the pending notice carries — the exhaustion text {@link decideEdit}
 * chose. It outlives {@link clearNotice} on purpose: callers drop the latch
 * first and render second, and the next notice overwrites it, so it cannot go
 * stale.
 */
export function pendingNoticeText(state) {
	return state.pendingNoticeText;
}

/** Drop the notice latch once its notice has been attached. */
export function clearNotice(state) {
	state.pendingNotice = undefined;
}

/**
 * Whether the reason clears the *reason* check. Implementation rule: a non-blank
 * reason on a spent stretch is the whole approval — no model judging, no user
 * confirmation. Deliberately absent from every model-visible string below.
 */
export function reviewRequest(reason) {
	return typeof reason === 'string' && reason.trim() !== '';
}

/**
 * Answer one `request_more_edits` call. Pure: it reads the mode, the reason and
 * the stretch's usage, and returns the result — granting nothing itself.
 *
 * All four outcomes are ordinary results, never a throw and never a deny — a
 * refused tool call reads as breakage to the model, and "wrong mode" /
 * "no reason" / "not yet" are all ordinary mistakes. The checks run in that
 * order so each refusal names the most useful thing; `granted` / `extra` keep
 * their shape, `note` says which refusal it was, and the caller renders the copy.
 *
 * The quota check is the gate on the escape hatch: a stretch that still has
 * calls left (`spent < quota`) refuses the request, so the hatch only opens once
 * the stretch is spent. A grant raises the quota, which makes it unspent
 * again — "spend it, ask, spend it, ask" cycles, with no cap on the number of
 * grants.
 *
 * ponytail: the tool stays registered outside multi mode on purpose (a toggled
 * catalog flushes the KV cache), so the mode check has to live in the answer,
 * not in the registration. The ceiling is that the description is still shown
 * to a non-multi model; hiding it would need a catalog swap per switch.
 *
 * @param {{ mode: string | null, reason: unknown, spent?: number, quota?: number, amount?: number }} request
 * @returns {{ granted: boolean, extra: number, spent: number, quota: number, note?: 'not-multi' | 'blank-reason' | 'quota-not-spent' }}
 */
export function decideRequest({ mode, reason, spent = 0, quota = 0, amount = GRANT }) {
	if (mode !== MULTI_ID) return { granted: false, extra: 0, spent, quota, note: 'not-multi' };
	if (!reviewRequest(reason)) return { granted: false, extra: 0, spent, quota, note: 'blank-reason' };
	if (spent < quota) return { granted: false, extra: 0, spent, quota, note: 'quota-not-spent' };
	return { granted: true, extra: amount, spent, quota };
}

/**
 * Every model-facing string in this file is English, like the rest of the
 * deployment's model-facing text (MULTI_SECTION, tool descriptions). ponytail:
 * control text the model has to follow reads more reliably in the same language
 * as the instructions it sits next to; the operator reads the report, not this.
 */

/**
 * The wake brief: an independent conversation notice, delivered at the moment a
 * refresh lands — before any call of the new stretch runs — rather than a notice
 * attached to a call, and not part of MULTI_SECTION. `state` is read at wake
 * time, where `extra` is 0, so `quotaOf` prints the plain `LIMIT`.
 *
 * The wording follows the deployment: `caps.hasRunCode` picks the PTC branch
 * (the count is per `run_code` call) or the direct-call branch, and
 * `caps.hasTeam` adds the team tools to the free list.
 *
 * ponytail: the budget number and the grant size both interpolate constants
 * (LIMIT / GRANT) that `self-check-gate.mjs` pins, so raising either needs no
 * copy edit here — only the other strings that hard-code them.
 */
export function wakeNoticeText(state, caps = { hasRunCode: true, hasTeam: false }) {
	return budgetBrief(caps, quotaOf(state));
}

/**
 * The exhaustion copy: attached to the call that spends the quota's last unit,
 * and repeated verbatim behind a denial, where it is the only text the model
 * gets. Branch-free on purpose — it is read at the moment of refusal, where the
 * one useful thing is the way out.
 */
export function blockedText() {
	return `You are in multi mode and this stretch's tool-call budget is used up. A call that only dispatches delegation tools spends nothing; every other call spends one. Delegate the remaining work to a subagent. If this part genuinely has to stay with you, call \`request_more_edits\` and explain in \`reason\` why you are not delegating and how far you will take it yourself; a granted reason adds ${GRANT} more. There is no way around the count: a workaround only hits this refusal.`;
}

/** The same warning behind a denial, prefixed so a PTC caller does not read it as breakage. */
export function denyReason() {
	return 'This is multi mode\'s tool-call gate, not a broken tool. ' + blockedText();
}

/** The empty-reason answer, shown only to the model that just called the tool. */
export function blankReasonReason() {
	return '`request_more_edits` needs a `reason`: why you are not delegating this, and how far you will take it yourself.';
}

/**
 * Shown when the stretch still has quota left. It repeats the usage the verdict
 * was made from, because "not yet" without a number tells the model nothing
 * about how far it is from the threshold.
 */
export function quotaNotSpentReason(used, quota) {
	return `Not yet: this stretch's tool-call budget is not used up (${used} of ${quota} used). Spend the calls this stretch already allows; once it runs out you can request more, or delegate the rest to a subagent.`;
}

/** Shown when the tool is called outside multi mode: no quota, no error either. */
export function notMultiReason() {
	return '`request_more_edits` only applies in multi mode. The current mode is not multi, so nothing was granted.';
}

/** Shown when a request is approved. */
export function grantedReason(extra) {
	return `Granted: ${extra} more calls in this stretch.`;
}
