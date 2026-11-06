/**
 * FROZEN LEGACY FOLDS — MIGRATION BASELINE. DO NOT EDIT.
 *
 * 这是迁移基准，不许改。它是两个旧插件 fold 的逐字冻结副本，唯一用途是给
 * self-check-fold.mjs 做新旧对比。
 *
 * Source of the two function bodies (copied verbatim, no reformatting):
 *
 *   foldCursorPlan  <- dsh-cursor-plan/lib/cursor-plan.js:228-253
 *   modeView(plan)  <- dsh-cursor-plan/lib/cursor-plan.js:262-269
 *   foldMode        <- dsh-modes/lib/modes.js:233-258
 *   modeView(multi) <- dsh-modes/lib/modes.js:267-274
 *
 * Why copy instead of import: importing would make the "old" side move whenever
 * the old plugins change, and then a real regression could hide behind a
 * matching edit on both sides. The bytes here are pinned on purpose. The only
 * thing allowed to be imported is CONSTANTS (MULTI_ID, PLAN_MODE_ID, ...), and
 * even those are re-stated below so this file has no live dependency on a
 * plugin that is scheduled for deletion.
 *
 * @module dsh-cursor-modes/tools/legacy-fold
 */

// ---------------------------------------------------------------------------
// Constants, re-stated from the two old modules (not imported — see header).
// ---------------------------------------------------------------------------

/** dsh-cursor-plan/lib/cursor-plan.js:13 */
export const PLAN_MODE_ID = 'plan';

/** dsh-cursor-plan/lib/cursor-plan.js:19 */
export const PLAN_COMMAND = 'cursor-plan';

/** dsh-cursor-plan/lib/cursor-plan.js:25 */
export const PLAN_EVENT = 'cursorPlan/state';

/** dsh-modes/lib/modes.js:13 */
export const MULTI_ID = 'multi';

/** dsh-modes/lib/modes.js:20 */
export const MULTI_COMMAND = 'cursor-multi';

/** dsh-modes/lib/modes.js:23 — the legacy multi event name. */
export const MODE_EVENT = 'mode/selected';

/** dsh-cursor-plan/lib/cursor-plan.js:215 */
const OFF_ARGS = new Set(['off', 'build']);

// ---------------------------------------------------------------------------
// dsh-cursor-plan/lib/cursor-plan.js:228-253 — verbatim
// ---------------------------------------------------------------------------

/**
 * Pure fold over committed session events. `cursorPlan/state` commits the mode
 * (anything other than `'plan'` folds to `null`). `command/run` / `command/done`
 * for `cursor-plan` record the not-yet-committed target so the chip can flip
 * when the command is submitted, matching plan's `pending`. `request/header`
 * records what the last assembled request was told.
 *
 * @param {object} state
 * @param {{ type?: string, data?: { mode?: unknown, name?: string, args?: unknown, commandId?: string, kind?: string } }} event
 * @returns {object} next state, the same reference when the event is unrelated.
 */
export function foldCursorPlan(state, event) {
	if (event?.type === 'command/run' && event.data?.name === PLAN_COMMAND) {
		if (typeof event.data.args !== 'string') return state;
		return {
			...state,
			running: {
				commandId: String(event.data.commandId ?? ''),
				wanted: !OFF_ARGS.has(event.data.args.trim())
			}
		};
	}
	if (event?.type === 'command/done' && state.running != null && event.data?.commandId === state.running.commandId) {
		const active = state.mode === PLAN_MODE_ID;
		const wanted = event.data.kind === 'success' && state.running.wanted !== active ? state.running.wanted : null;
		return { ...state, wanted, running: null };
	}
	if (event?.type === PLAN_EVENT) {
		return { ...state, mode: event.data?.mode === PLAN_MODE_ID ? PLAN_MODE_ID : null, wanted: null };
	}
	if (event?.type === 'request/header') {
		const told = state.mode === PLAN_MODE_ID ? PLAN_MODE_ID : 'default';
		if (state.modeAtHeader === told) return state;
		return { ...state, modeAtHeader: told };
	}
	return state;
}

// ---------------------------------------------------------------------------
// dsh-cursor-plan/lib/cursor-plan.js:262-269 — verbatim
// ---------------------------------------------------------------------------

/**
 * Cropped wire view. `pending` is true while a submitted command wants a
 * different switch than the committed mode.
 *
 * @param {{ mode?: string | null, wanted?: boolean | null, running?: { wanted: boolean } | null }} state
 * @returns {{ mode: string | null, pending: boolean }}
 */
export function cursorPlanView(state) {
	const wanted = state.running?.wanted ?? state.wanted ?? null;
	const active = state.mode === PLAN_MODE_ID;
	return {
		mode: state.mode === PLAN_MODE_ID ? PLAN_MODE_ID : null,
		pending: wanted !== null && wanted !== active
	};
}

// ---------------------------------------------------------------------------
// dsh-modes/lib/modes.js:233-258 — verbatim
// ---------------------------------------------------------------------------

/**
 * Pure fold over committed session events. `mode/selected` commits the mode
 * (anything other than `'multi'` folds to `null`). `command/run` /
 * `command/done` for `cursor-multi` record the not-yet-committed target so the
 * chip can flip when the command is submitted, matching plan's `pending`.
 * `request/header` records what the last assembled request was told.
 *
 * @param {object} state
 * @param {{ type?: string, data?: { mode?: unknown, name?: string, args?: unknown, commandId?: string, kind?: string } }} event
 * @returns {object} next state, the same reference when the event is unrelated.
 */
export function foldMode(state, event) {
	if (event?.type === 'command/run' && event.data?.name === MULTI_COMMAND) {
		if (typeof event.data.args !== 'string') return state;
		return {
			...state,
			running: {
				commandId: String(event.data.commandId ?? ''),
				wanted: event.data.args.trim() !== 'off'
			}
		};
	}
	if (event?.type === 'command/done' && state.running != null && event.data?.commandId === state.running.commandId) {
		const active = state.mode === MULTI_ID;
		const wanted = event.data.kind === 'success' && state.running.wanted !== active ? state.running.wanted : null;
		return { ...state, wanted, running: null };
	}
	if (event?.type === MODE_EVENT) {
		return { ...state, mode: event.data?.mode === MULTI_ID ? MULTI_ID : null, wanted: null };
	}
	if (event?.type === 'request/header') {
		const told = state.mode === MULTI_ID ? MULTI_ID : 'default';
		if (state.modeAtHeader === told) return state;
		return { ...state, modeAtHeader: told };
	}
	return state;
}

// ---------------------------------------------------------------------------
// dsh-modes/lib/modes.js:267-274 — verbatim
// ---------------------------------------------------------------------------

/**
 * Cropped wire view. `pending` is true while a submitted command wants a
 * different switch than the committed mode.
 *
 * @param {{ mode?: string | null, wanted?: boolean | null, running?: { wanted: boolean } | null }} state
 * @returns {{ mode: string | null, pending: boolean }}
 */
export function modeView(state) {
	const wanted = state.running?.wanted ?? state.wanted ?? null;
	const active = state.mode === MULTI_ID;
	return {
		mode: state.mode === MULTI_ID ? MULTI_ID : null,
		pending: wanted !== null && wanted !== active
	};
}

// ---------------------------------------------------------------------------
// Init states, verbatim from each plugin's projection definition.
//   dsh-cursor-plan/lib/index.js:67  -> { mode: null, modeAtHeader: null, wanted: null, running: null }
//   dsh-modes/lib/index.js:68        -> { mode: null, modeAtHeader: null, wanted: null, running: null }
// Both plugins use the identical init shape, so one factory covers both.
// ---------------------------------------------------------------------------

/** Init state for either legacy projection. */
export function legacyInit() {
	return { mode: null, modeAtHeader: null, wanted: null, running: null };
}

/** Init state for the plan projection (alias, for readable call sites). */
export const legacyPlanInit = legacyInit;

/** Init state for the multi projection (alias, for readable call sites). */
export const legacyMultiInit = legacyInit;

/**
 * Fold one full session through BOTH legacy folds and combine the way the two
 * old projections were combined by the UI: plan wins over multi.
 *
 * This is the expression the sweep in blueprint §3.5.2 compares against —
 * kept here so the self-check has exactly one definition of "legacy answer".
 *
 * @param {readonly { type?: string, data?: object }[]} events
 * @returns {{ mode: string, plan: string | null, multi: string | null }}
 */
export function legacyFoldSession(events) {
	let plan = legacyPlanInit();
	let multi = legacyMultiInit();
	for (const event of events) {
		plan = foldCursorPlan(plan, event);
		multi = foldMode(multi, event);
	}
	const mode = plan.mode === 'plan' ? 'plan' : multi.mode === 'multi' ? 'multi' : 'default';
	return { mode, plan: plan.mode, multi: multi.mode };
}
