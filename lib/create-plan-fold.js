/**
 * Pure fold for the Created Plan turnTail card. Shared by self-check and
 * inlined into the client ModuleLoader bundle (the bundle cannot import this
 * file). Keep both copies in sync.
 *
 * @module dsh-cursor-plan/create-plan-fold
 */

/** Wire tool name this card settles from. */
export const PLAN_TOOL = 'create_plan';

/** Session event carrying an on-disk plan body after a `.plan.md` edit. */
export const PLAN_DOC_EVENT = 'cursorPlan/planDoc';

/** Turn-data key published beside Chat nodes (must equal definition.kind). */
export const TURN_DATA_KEY = 'cursor-plan';

/**
 * Text of the first text block in a native tool-result message, or "".
 *
 * @param {unknown} message
 * @returns {string}
 */
export function toolResultText(message) {
	const outer = message && typeof message === 'object' && Array.isArray(/** @type {{ content?: unknown }} */ (message).content)
		? /** @type {{ content: unknown[] }} */ (message).content[0]
		: undefined;
	const blocks = outer && typeof outer === 'object' && Array.isArray(/** @type {{ content?: unknown }} */ (outer).content)
		? /** @type {{ content: unknown[] }} */ (outer).content
		: [];
	const texts = [];
	for (const block of blocks) {
		if (block && typeof block === 'object' && /** @type {{ type?: string, text?: string }} */ (block).type === 'text'
			&& typeof /** @type {{ text?: string }} */ (block).text === 'string') {
			texts.push(/** @type {{ text: string }} */ (block).text);
		}
	}
	return texts.join('\n');
}

/**
 * Text joined from a PTC dispatch `content` array, or "".
 *
 * @param {unknown} content
 * @returns {string}
 */
export function ptcResultText(content) {
	if (!Array.isArray(content)) return '';
	const texts = [];
	for (const block of content) {
		if (block && typeof block === 'object' && /** @type {{ type?: string, text?: string }} */ (block).type === 'text'
			&& typeof /** @type {{ text?: string }} */ (block).text === 'string') {
			texts.push(/** @type {{ text: string }} */ (block).text);
		}
	}
	return texts.join('\n');
}

/**
 * JSON string for PlanCard's callArgs parser. PTC arguments are already objects.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function argsRawOf(args) {
	if (typeof args === 'string') return args;
	return JSON.stringify(args ?? {});
}

/**
 * Map of tool callId → turn, filled while matching so PTC sub-dispatches
 * (which carry no turn field) can join the same turn context.
 *
 * @returns {Map<string, number>}
 */
export function createCallTurnMap() {
	return new Map();
}

/**
 * Match one session event for the create_plan accumulator.
 *
 * @param {{ type?: string, surfaceOp?: unknown, data?: Record<string, unknown> } | null | undefined} event
 * @param {Map<string, number>} callTurn
 * @returns {{ id: string, role: 'start' | 'update' } | null}
 */
export function matchCreatePlan(event, callTurn) {
	if (event?.type === 'turn/start') {
		return { id: String(event.data?.turn), role: 'start' };
	}
	if (event?.type === 'tool/call') {
		const callId = event.data?.callId;
		const turn = event.data?.turn;
		if (callId != null && typeof turn === 'number') callTurn.set(String(callId), turn);
		if (event.data?.name === PLAN_TOOL) return { id: String(turn), role: 'update' };
		return null;
	}
	if (event?.type === 'tool/result' && event.surfaceOp === 'append') {
		return { id: String(event.data?.turn), role: 'update' };
	}
	if ((event?.type === 'tool/ptc-dispatch-start' || event?.type === 'tool/ptc-dispatch')
		&& event.data?.name === PLAN_TOOL) {
		const turn = callTurn.get(String(event.data.rootCallId))
			?? callTurn.get(String(event.data.parentCallId));
		if (turn === undefined) return null;
		return { id: String(turn), role: 'update' };
	}
	if (event?.type === PLAN_DOC_EVENT) {
		const turn = event.data?.turn;
		if (typeof turn !== 'number') return null;
		return { id: String(turn), role: 'update' };
	}
	return null;
}

/**
 * @param {unknown} _context
 * @param {{ event: { type?: string, data?: { turn?: number } } }} match
 */
export function startCreatePlan(_context, match) {
	if (match.event.type !== 'turn/start') throw new Error('cursor-plan start requires turn/start');
	return {
		turn: match.event.data?.turn,
		calls: new Map(),
		plans: []
	};
}

/**
 * @param {{ state: { turn: number, calls: Map<string, string>, plans: object[] } }} context
 * @param {{ event: { type?: string, seq?: number, data?: Record<string, unknown> } }} match
 */
export function updateCreatePlan(context, match) {
	const event = match.event;
	if (event.type === 'tool/call') {
		const calls = new Map(context.state.calls);
		calls.set(String(event.data?.callId), /** @type {string} */ (event.data?.arguments));
		return { ...context.state, calls };
	}
	if (event.type === 'tool/ptc-dispatch-start') {
		const calls = new Map(context.state.calls);
		calls.set(String(event.data?.subCallId), argsRawOf(event.data?.arguments));
		return { ...context.state, calls };
	}
	if (event.type === 'tool/result') {
		const message = event.data?.message;
		const outer = message && typeof message === 'object' && Array.isArray(/** @type {{ content?: unknown }} */ (message).content)
			? /** @type {{ content: unknown[] }} */ (message).content[0]
			: undefined;
		if (outer && typeof outer === 'object' && /** @type {{ isError?: boolean }} */ (outer).isError === true) {
			return context.state;
		}
		const callId = String(message && typeof message === 'object'
			? /** @type {{ source?: { callId?: unknown } }} */ (message).source?.callId
			: undefined);
		const argsRaw = context.state.calls.get(callId);
		if (argsRaw === undefined) return context.state;
		return {
			...context.state,
			plans: [...context.state.plans, {
				seq: event.seq,
				argsRaw,
				resultText: toolResultText(message)
			}]
		};
	}
	if (event.type === 'tool/ptc-dispatch') {
		if (event.data?.isError === true) return context.state;
		const callId = String(event.data?.subCallId);
		const argsRaw = context.state.calls.get(callId);
		if (argsRaw === undefined) return context.state;
		return {
			...context.state,
			plans: [...context.state.plans, {
				seq: event.seq,
				argsRaw,
				resultText: ptcResultText(event.data?.content)
			}]
		};
	}
	if (event.type === PLAN_DOC_EVENT) {
		const path = typeof event.data?.path === 'string' ? event.data.path : '';
		const plan = typeof event.data?.plan === 'string' ? event.data.plan : '';
		return {
			...context.state,
			plans: [...context.state.plans, {
				seq: event.seq,
				argsRaw: JSON.stringify({ plan }),
				resultText: path === '' ? '' : `Plan file: ${path}\n`
			}]
		};
	}
	return context.state;
}

/**
 * Replay a short event list through the fold. Self-check only.
 *
 * @param {readonly object[]} events
 * @returns {{ turn: number, calls: Map<string, string>, plans: object[] } | undefined}
 */
export function foldCreatePlanEvents(events) {
	const callTurn = createCallTurnMap();
	/** @type {{ turn: number, calls: Map<string, string>, plans: object[] } | undefined} */
	let state;
	for (const event of events) {
		const hit = matchCreatePlan(/** @type {any} */ (event), callTurn);
		if (hit === null) continue;
		if (hit.role === 'start') {
			state = startCreatePlan(undefined, { event: /** @type {any} */ (event) });
			continue;
		}
		if (state === undefined) continue;
		state = updateCreatePlan({ state }, { event: /** @type {any} */ (event) });
	}
	return state;
}
