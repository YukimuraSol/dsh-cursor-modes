/**
 * Mode switching: the pure half. The mode control's staged selection, the one
 * moment a staged choice becomes real, and the single sentence that announces
 * it.
 *
 * There is no command path left (2026-10-23). `/cursor-plan` and `/cursor-multi`
 * are not registered anywhere: the mode is changed from the composer's mode
 * control, which posts to the `/switch` bridge, and it lands at the step that
 * claims the user's own message (`state.js` `commitPending`, 口径 S1). Removing
 * the commands removed `netChange` / `submitCommands` / `applyNetChange` with
 * them — and with them the `command/run` + `command/done` receipts the
 * conversation used to render for every switch.
 *
 * What is left here is what both paths still need: the mode alphabet, the
 * pending-bridge prefix, the Build-click test, the one switch sentence, and the
 * capability probe the sentence's budget line depends on.
 *
 * @module dsh-cursor-modes/switch
 */

import { BUDGET_RECEIPT, MULTI_ID, budgetBrief } from './multi-prompt.js';

/**
 * The three mode ids, in mutual-exclusion order.
 *
 * Was `['default', 'cursorPlan', 'cursorMulti']` (dsh-mode-switch/lib/index.js:270).
 * The merge collapsed the two owners' private ids into the projection's single
 * vocabulary, so these now match `state.MODES` and `projection.modeStateSchema`.
 */
export const MODE_IDS = ['default', 'plan', 'multi'];

/** The two switchable modes, in mutual-exclusion order. */
export const SWITCHABLE = MODE_IDS.filter((id) => id !== 'default');

/** Loopback JSON bridge the mode control stages its choice on. */
export const BRIDGE_PREFIX = '/api/dsh-cursor-modes/switch';

/**
 * The mode id, or `undefined` when the value is not a known mode.
 *
 * Accepts the OLD id vocabulary as well as the new one. A browser may still be
 * running the previous client's JS, which posts 'cursorPlan' / 'cursorMulti'
 * (blueprint §4.4); mapping them here is one line that retires a whole class of
 * "switching modes does nothing" reports. New values pass through unchanged.
 *
 * @param {unknown} value
 * @returns {'default' | 'plan' | 'multi' | undefined}
 */
export function asModeId(value) {
	if (value === 'cursorPlan') return 'plan';
	if (value === 'cursorMulti') return 'multi';
	return typeof value === 'string' && MODE_IDS.includes(value) ? value : undefined;
}

/**
 * Summary dsh-cursor-plan's Build route stamps on the one message a Build click
 * leaves: `The user clicked ${BUILD_LABELS[choice]}.` with **no** quotes
 * (build.js:33, :67-85 — the label reaches the summary bare, while only the
 * message text wraps it in quotes).
 */
const BUILD_SUMMARY = /^The user clicked Build in (?:Multi|Default)\.$/;

/**
 * Whether one message is the message a Build click steered.
 *
 * @param {object} message
 * @returns {boolean}
 */
export function isBuildClick(message) {
	const source = message?.source;
	return source?.kind === 'cursor-plan'
		&& source.form === 'notice'
		&& typeof source.summary === 'string'
		&& BUILD_SUMMARY.test(source.summary);
}

/** The model-facing name of each mode, as the notice below spells it. */
const NOTICE_MODE_NAMES = { plan: 'plan', multi: 'multitask' };

/**
 * The one line a switch notice shows in the conversation. The body carries the
 * full sentence the model reads; this is the human-readable receipt that
 * replaced the two command receipts a cross-mode switch used to print.
 *
 * @param {string} mode the mode just entered.
 * @returns {string}
 */
export function switchSummary(mode) {
	return 'dsh-cursor-modes: switched to ' + String(mode) + ' mode';
}

/**
 * Which optional capabilities this deployment presents, as the budget copy needs
 * them: `hasRunCode` (the preset mounts the PTC carrier) and `hasTeam` (the
 * Agent Teams tools are mounted).
 *
 * @param {object} host context carrying `tools`
 * @param {object} [agent] the viewing scope; omitted = the global view.
 * @returns {{ hasRunCode: boolean, hasTeam: boolean }}
 */
export function capsOf(host, agent) {
	const has = (name) => {
		try {
			return host?.tools?.get?.(name, agent) !== undefined;
		} catch {
			return false;
		}
	};
	return { hasRunCode: has('run_code'), hasTeam: has('team_task_list') };
}

/**
 * The one sentence that replaces the owners' two. Three shapes, matching what
 * the owners themselves say:
 *
 * - into a mode from the default — `…to plan mode.` (the owner's own wording)
 * - back to the default — `…back to the default mode.` (the owner's own wording)
 * - between two modes — `…from plan mode to multitask mode.` The `from` clause
 *   exists *because* the leave notice was withdrawn: the model would otherwise
 *   lose the one signal telling it which mode it is coming from.
 *
 * `from` is only ever added to a cross-mode switch; the default is "no mode",
 * so for `default <-> X` the origin is already implied and saying it would be
 * noise.
 *
 * The budget line is appended exactly when the target is multi, in the wording
 * this deployment's tools call for, so the model hears the metering rules the
 * first time it enters multi.
 *
 * @param {string} from - the mode being left.
 * @param {string} to - the mode being entered.
 * @param {{ hasRunCode?: boolean, hasTeam?: boolean }} [caps]
 * @returns {string | undefined} the notice text, or `undefined` for a no-op switch.
 */
export function compositeNoticeText(from, to, caps = { hasRunCode: true, hasTeam: false }) {
	// A fresh session's projection reads `null` for "no mode yet" (and `state.mode`
	// is a fallback string); both mean default, and neither may print as "null".
	const origin = from ?? 'default';
	if (origin === to) return undefined;
	if (to === 'default') return 'The user switched this session back to the default mode.';
	const target = NOTICE_MODE_NAMES[to];
	if (target === undefined) throw new Error('unknown mode: ' + String(to));
	const into = origin === 'default'
		? 'The user switched this session to ' + target + ' mode.'
		: 'The user switched this session from ' + NOTICE_MODE_NAMES[origin] + ' mode to ' + target + ' mode.';
	return to === MULTI_ID ? into + ' ' + budgetBrief(caps) : into;
}

/**
 * The steps one self-test runs when the caller does not name any: enter plan
 * mode, then switch to multi. The second step is the interesting one — it must
 * commit a cross-mode switch through the same claim path a real send takes.
 *
 * @param {unknown} value
 * @returns {Array<{ target: string, text: string, waitMs: number }>}
 */
export function selfTestSteps(value) {
	if (!Array.isArray(value) || value.length === 0) {
		return [
			{ target: 'plan', text: 'hi', waitMs: 1500 },
			{ target: 'multi', text: 'ok', waitMs: 1500 }
		];
	}
	return value.slice(0, 4).map((entry) => ({
		target: asModeId(entry && entry.target) ?? 'default',
		text: typeof (entry && entry.text) === 'string' && entry.text !== '' ? entry.text : 'hi',
		waitMs: typeof (entry && entry.waitMs) === 'number' && entry.waitMs >= 0 && entry.waitMs <= 20000 ? entry.waitMs : 1500
	}));
}

/** Kept as a named export so the constant copy has one home; see multi-prompt.js. */
export { BUDGET_RECEIPT };
