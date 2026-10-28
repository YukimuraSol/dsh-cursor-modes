/**
 * Multi (multitask) mode's half of `dsh-cursor-modes`: the `mode:policy`
 * section (order 501), the per-Agent tool-call quota gate, the
 * `request_more_edits` tool, and the two quota notices.
 *
 * Moved here from `dsh-modes/lib/index.js` (blueprint §1.5, §4.2):
 *
 *   quotaNotice            :214-220
 *   wakeBriefNotice        :228-234
 *   wireEditGate's gateOf  :253-260   (the WeakMap survives as `state.quota`)
 *   wireEditGate's turnOf  :263-265
 *   wireEditGate's settle  :285-288
 *   `agent/inbox/claimed`   :277-279
 *   `agent/pre-step` body   :290-304   (commit + settle + wake brief)
 *   `request_more_edits`    :310-365
 *   `tools/pre-execute` body:369-381   ({@link editGate})
 *   `tools/post-execute` body :386-395 ({@link attachQuotaNotice})
 *   section `mode:policy`    :418-427
 *
 * ## Boundary discipline (blueprint §1.5)
 *
 * - The mode is READ through {@link selectedMode} only (I2); this file never
 *   reads `stateOf(session, 'mode').mode` and never writes `state.pending`.
 * - `state.quota` (a `WeakMap<Agent, GateState>`) is the ONE gate store (I4):
 *   HTTP routes have no agent, so they must not touch it.
 * - Every pure decision lives in `gate.js` unchanged; nothing here re-derives a
 *   count or a copy.
 * - Sections and tools are registered in {@link wireMulti}; the hook BODIES are
 *   exported as plain functions so `index.js` owns the single registration
 *   point of each hook (blueprint §4.2, §5.3).
 *
 * @module dsh-cursor-modes/multi
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
	applyWake,
	blankReasonReason,
	clearNotice,
	decideEdit,
	decideRequest,
	grantExtra,
	grantedReason,
	initState,
	notMultiReason,
	observeWake,
	pendingNoticeText,
	quotaNotSpentReason,
	quotaOf,
	rollTurn,
	settleRoot,
	spentOf,
	takesNotice,
	wakeNoticeText
} from './gate.js';
import { MULTI_ID, MULTI_SECTION, MULTI_SECTION_TEAM, quotaToolDescription } from './multi-prompt.js';
import { commitPending, selectedMode } from './state.js';
import { capsOf } from './switch.js';

/**
 * The live mount, captured by {@link wireMulti}.
 *
 * Both agreed signatures (`gateOf(agent)` and `settle(gate, session)`) take no
 * host, so the host and the state bag are captured here when the plugin mounts.
 * One mount per process is the supported shape; a second mount rebinds these to
 * the newer context, exactly like the two legacy plugins each had a single
 * `apply()` per process.
 */
let mounted = null;

/**
 * Fallback quota store used only if a caller reaches the gate before
 * {@link wireMulti} ran. Once mounted, `state.quota` replaces it, so the map is
 * the state bag's own field and never a second copy.
 */
let quota = new WeakMap();

/** Per-Agent gate state, created on first sight. Keyed by the EXACT agent. */
export function gateOf(agent) {
	let gate = quota.get(agent);
	if (gate === undefined) {
		gate = initState();
		quota.set(agent, gate);
	}
	return gate;
}

/**
 * The turn this session is on, or 0 before the first one.
 *
 * @param {object} session
 * @returns {number}
 */
function turnOf(session) {
	return mounted.host.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0;
}

/**
 * Apply any pending wake and re-read the turn, so a resumed session picks up a
 * boundary it never saw claimed. An in-turn steer keeps the same number and
 * therefore the same quota — only the wake kinds reset, and a timer-driven
 * follow-up deliberately does not.
 *
 * @param {object} gate
 * @param {object} session
 * @returns {boolean} true when the quota was actually refreshed
 */
export function settle(gate, session) {
	if (applyWake(gate)) return true;
	return rollTurn(gate, turnOf(session), gate.sourceKind);
}

/**
 * The exhaustion notice, attached to the call that spends the last of the
 * quota. `gate` is read after the charge and after the latch was dropped, so the
 * copy is the stashed one, never a re-derived count.
 *
 * The kind stays `'dsh-modes'` verbatim: it is this plugin's OWN budget notice,
 * and `state.js`'s `NOTICE_KINDS` deliberately omits that kind so
 * {@link import('./state.js').dropStaleNotices} can never sweep a live budget
 * line. Renaming it to `'dsh-cursor-modes'` would make a later mode switch
 * withdraw it.
 *
 * @param {object} gate
 * @returns {object} a user-role message carrying the notice
 */
export function quotaNotice(gate) {
	const text = pendingNoticeText(gate);
	return createUserMessage({
		content: [{ type: 'text', text }],
		source: { kind: 'dsh-modes', form: 'notice', summary: text }
	});
}

/**
 * The wake brief: an independent conversation notice appended to the step that
 * applies a real quota refresh, so it lands before any call of the new stretch
 * runs. Same shape as {@link quotaNotice}, which is what keeps it withdrawable
 * by the same rules (i.e. never).
 *
 * @param {object} gate
 * @param {{ hasRunCode?: boolean, hasTeam?: boolean }} [caps]
 * @returns {object}
 */
export function wakeBriefNotice(gate, caps) {
	const text = wakeNoticeText(gate, caps);
	return createUserMessage({
		content: [{ type: 'text', text }],
		source: { kind: 'dsh-modes', form: 'notice', summary: text }
	});
}

/**
 * The `tools/post-execute` half: attach the exhaustion notice to the ONE call
 * the gate picked — the call that spent the quota's last unit.
 *
 * Returns a NEW decision object (`additionalContexts` is the only channel the
 * model actually sees), so the caller must hand the return value on; that is why
 * blueprint §4.6 runs this BEFORE the plan-side append.
 *
 * @param {object} exec
 * @param {object} decision the decision from `next()`
 * @returns {object} possibly a new decision
 */
export function attachQuotaNotice(exec, decision) {
	if (exec.agent === undefined || mounted === null) return decision;
	if (selectedMode(mounted.host, mounted.state, exec.agent.session) !== MULTI_ID) return decision;
	const gate = gateOf(exec.agent);
	if (!takesNotice(gate, exec)) return decision;
	clearNotice(gate);
	return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], quotaNotice(gate)] };
}

/**
 * The `tools/post-execute` settle: a `run_code` whose charge was deferred is
 * priced here — free when every dispatch was a delegation tool, one unit when it
 * dispatched anything else (already charged at that dispatch), and one unit when
 * it dispatched nothing at all. Runs before {@link attachQuotaNotice} so a charge
 * that spends the last unit still gets its notice.
 *
 * Outside multi mode the gate neither charges nor settles.
 *
 * @param {object} exec
 */
export function settleExec(exec) {
	if (exec?.agent === undefined || mounted === null) return;
	if (selectedMode(mounted.host, mounted.state, exec.agent.session) !== MULTI_ID) return;
	settleRoot(gateOf(exec.agent), exec);
}

/**
 * The `tools/pre-execute` half of the multi gate: settle the stretch, then judge
 * the call. Returns `gate.js`'s own verdict unchanged —
 * `null` (not this gate's business) | `{kind:'allow'}` |
 * `{kind:'notify', root, text}` | `{kind:'deny', reason}`.
 *
 * `notify` means "let it run, the notice rides its result"; `deny` means "refuse
 * with this reason". Count and deny here, never in post-execute: a denied call
 * still reaches post-execute, so counting there would charge the blocked call.
 *
 * A `run_code` is NOT charged here — `gate.js` records a provisional entry and
 * {@link settleExec} prices it. That is what keeps a spent stretch able to
 * delegate: the carrier is always allowed, and only a non-delegation dispatch
 * inside it is refused.
 *
 * The mode check comes FIRST, exactly as the legacy handler did (`gated()`
 * before `settle`): outside multi mode the gate neither charges nor settles, so
 * a plan-mode `write` is never billed against a quota that is not in force.
 *
 * @param {object} exec
 * @param {object} gate
 * @returns {null | { kind: 'allow' | 'deny' | 'notify', reason?: string }}
 */
export function editGate(exec, gate) {
	if (exec?.agent === undefined || mounted === null) return null;
	if (selectedMode(mounted.host, mounted.state, exec.agent.session) !== MULTI_ID) return null;
	settle(gate, exec.agent.session);
	return decideEdit(exec, { mode: MULTI_ID, state: gate });
}

/**
 * The `agent/pre-step` half: commit a staged switch (only when this step
 * delivered the user's own message, 口径 S1), settle the stretch, and let the
 * wake brief ride the step that applied a real reset.
 *
 * Commit first, settle second: the mode the control staged is now in the log, so
 * the mode read below is the committed one, and the quota is measured against
 * the mode the step actually runs in. The brief rides only a *real* refresh, so
 * a goal/schedule wake — which keeps the count — never claims one.
 *
 * @param {object} host
 * @param {object} state
 * @param {{ session: object }} agent
 * @param {{ aborted?: boolean }} [signal]
 * @param {object} decision
 * @returns {object} the decision to hand on
 */
export function commitMultiMode(host, state, agent, signal, decision) {
	if (decision?.kind === 'reject') return decision;
	const committed = commitPending(host, state, agent, decision, signal, { requireUserMessage: true });
	const gate = gateOf(agent);
	const refreshed = settle(gate, agent.session);
	if (!refreshed || selectedMode(host, state, agent.session) !== MULTI_ID) return committed;
	const brief = wakeBriefNotice(gate, capsOf(host, agent));
	return { ...committed, messages: [...committed.messages ?? [], brief] };
}

/**
 * Register what multi mode owns on the host: the `mode:policy` section, the
 * `request_more_edits` tool, and the `agent/inbox/claimed` wake observer.
 *
 * The section order stays 501 (blueprint §4.3): just past the official
 * `plan:policy` (500) and before `team:policy` (600), byte-identical to what
 * `dsh-modes` produced for any multi-only session.
 *
 * The tool is registered UNCONDITIONALLY so the request tool catalog is constant
 * across mode switches: a toggled catalog flushes the KV cache from the first
 * changed schema token. Outside multi mode the call is answered, not denied —
 * `decideRequest` returns an ordinary result saying the tool does not apply.
 *
 * @param {object} host context carrying `systemPrompt`, `tools`, `sessionProjections`
 * @param {object} state the single state bag from `createState()`
 */
export function wireMulti(host, state) {
	mounted = { host, state };
	quota = state.quota;

	host.systemPrompt.section({
		name: 'mode:policy',
		order: 501,
		text: (context) => {
			if (context.agent === undefined) return '';
			return selectedMode(host, state, context.agent.session) === MULTI_ID
				? (host.tools.get('spawn_teammate', context.agent) !== undefined ? MULTI_SECTION_TEAM : MULTI_SECTION)
				: '';
		}
	});

	// A claimed message is a wake. Its turn number is the cycle; only the
	// whitelisted kinds in gate.js clear what the previous cycle spent. A
	// background subagent's report is claimed as `agent-message`; the
	// `subagent-settled` notice that follows arrives as an in-turn steer and is
	// consumed without ever being claimed.
	host.on('agent/inbox/claimed', ({ agent, message, turn }) => {
		observeWake(gateOf(agent), { turn, sourceKind: message?.source?.kind });
	});

	// The tool description is one static string, so the branch is chosen once from
	// the global view of the catalog: a deployment that presents `run_code` (ptc)
	// and one that does not (native) must not read the same metering sentence.
	// ponytail: the ceiling is a process that mounts both presentations at once —
	// the description then follows the global default, and only that wording is
	// ever shown. Upgrade path: a per-scope catalog, which would flush the KV cache
	// on every switch.
	const caps = capsOf(host);

	host.tools.register(defineTool({
		name: 'request_more_edits',
		description: quotaToolDescription(caps),
		parameters: {
			reason: {
				type: 'string',
				required: true,
				description: "Why you are not handing this work to a subagent (any honest reason counts) — and what you plan to finish next. E.g. quick read-only survey, or quick check of a subagent result."
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					granted: { type: 'boolean', required: true },
					extra: { type: 'number', required: true },
					// Which refusal it was; `render` maps it to the copy.
					note: { type: 'string', enum: ['not-multi', 'blank-reason', 'quota-not-spent'] },
					// The usage the not-yet refusal reports back, so its copy can name
					// how far the stretch still is from the threshold.
					spent: { type: 'number' },
					quota: { type: 'number' }
				}
			},
			render: (args, value) => [{
				type: 'text',
				text: value.granted
					? grantedReason(value.extra)
					: value.note === 'not-multi'
						? notMultiReason()
						: value.note === 'blank-reason'
							? blankReasonReason()
							: quotaNotSpentReason(value.spent, value.quota)
			}]
		},
		execute: async (args, exec) => {
			if (exec.agent === undefined) throw new Error('request_more_edits needs an agent to grant quota to');
			// ponytail: a non-blank reason on an already spent stretch is the whole
			// approval — no model judging and no user prompt, by decision. The
			// ceiling is that a rushed reason still buys quota; the upgrade path is a
			// judge pass if that shows up. The verdict is `gate.js`'s pure function,
			// so the whole four-way answer is covered without mounting a harness.
			// The usage is read here, from the same gate the edit hooks charge, so the
			// verdict and the copy cannot disagree.
			const gate = gateOf(exec.agent);
			const result = decideRequest({
				mode: selectedMode(host, state, exec.agent.session),
				reason: args.reason,
				spent: spentOf(gate),
				quota: quotaOf(gate)
			});
			if (result.granted) grantExtra(gate, result.extra);
			return result;
		}
	}));
}
