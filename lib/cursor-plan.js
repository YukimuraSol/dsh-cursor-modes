import { dirname, resolve } from 'node:path';

/**
 * Pure session-mode vocabulary for the `plan` mode this plugin owns (the
 * "Cursor Plan" mode in the UI): the mode id, the log fold, argument parsing,
 * config validation, and the switch notice. No cordis dependency, so the host
 * plugin and the self-check share exactly these functions.
 *
 * @module dsh-cursor-plan/cursor-plan
 */

/** The one mode this plugin manages. The model-facing mode name is plain `plan`. */
export const PLAN_MODE_ID = 'plan';

/** Host tool that writes the plan file. */
export const PLAN_TOOL = 'create_plan';

/** Command that switches the mode. `/plan` is the shipped plan mode's, so this one is namespaced. */
export const PLAN_COMMAND = 'cursor-plan';

/**
 * Log event whose payload is the committed mode. Required, not ignorable:
 * `foldCursorPlan` restores the mode from it.
 */
export const PLAN_EVENT = 'cursorPlan/state';

/**
 * Log event carrying the on-disk plan body after a successful `.plan.md` edit.
 * The client fold settles a turnTail card from it (same shape as create_plan).
 */
export const PLAN_DOC_EVENT = 'cursorPlan/planDoc';

/** Session projection key holding the folded mode. */
export const PLAN_PROJECTION = 'cursorPlan';

/** Notice source stamp; `planNoticeId` matches on exactly this triple. */
export const NOTICE_PLUGIN = 'cursor-plan';

const HOST_BIN = /(?:^|[\\/])@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/;

/**
 * Absolute path of the host's `@deepseek-ai/dsh-session` entry, derived from
 * the running `dsh` bin. `undefined` when this process was not started that way.
 *
 * @param {readonly string[]} argv `process.argv`.
 * @returns {string | undefined}
 */
export function sessionModuleFromArgv(argv) {
	const bin = argv.find((arg) => HOST_BIN.test(arg));
	if (bin === undefined) return undefined;
	return resolve(dirname(bin), '..', '..', 'dsh-session', 'lib', 'index.js');
}

/**
 * Make one event type known to this process. The harness has no registration
 * API; unknown types are refused unless marked ignorable, and ignorable means
 * "safe to skip". `cursorPlan/state` is not safe to skip — `foldCursorPlan`
 * restores the mode from it — so the type has to join the live vocabulary Set.
 *
 * @param {{ add: (type: string) => unknown, has: (type: string) => boolean } | null | undefined} known
 * @param {string} type
 */
export function registerEventType(known, type) {
	if (known == null || typeof known.add !== 'function' || typeof known.has !== 'function') {
		throw new Error('dsh-cursor-plan: host event vocabulary is not a Set');
	}
	known.add(type);
	if (!known.has(type)) throw new Error(`dsh-cursor-plan: failed to register ${type}`);
}

/**
 * The two judge backends: `jev` asks the decision model through its own
 * credential, `llm` asks the session's own chat model through the harness
 * `llm` service and needs no credential at all.
 */
export const JUDGE_BACKENDS = ['jev', 'llm'];

/**
 * The backend a gate value names, falling back to `jev` for anything else.
 * The fallback is deliberately silent here (this module is pure); the caller
 * that owns a logger reports the unknown value once.
 *
 * @param {unknown} value
 * @returns {'jev' | 'llm'}
 */
export function judgeBackend(value) {
	return value === 'llm' ? 'llm' : 'jev';
}

/**
 * Defaults of the optional `gate` block. `apiKey` is the JEV judge's own key,
 * stored as the plain string the settings card's connection row types in (empty
 * means "not set", never "clear it"); `apiKeyRef` is the older credential
 * reference and still resolves when `apiKey` is empty. `enabled: false` keeps
 * the gate off unless the deployment asks for it.
 *
 * `backend` picks the judge, and `model` is the model that judge uses. The
 * shipped default is `llm`: a deployment that sets nothing is judged by the
 * session's own model, so no judge credential is needed. Empty `model`
 * means "the backend's own default": `askJev` keeps requesting `jev-latest`,
 * and the `llm` backend follows the session's model. A pre-existing deployment
 * that still stores `model: jev-latest` is read exactly as it always was.
 */
export const GATE_DEFAULTS = {
	enabled: false,
	backend: 'llm',
	model: '',
	baseUrl: 'http://127.0.0.1:7899/api/v1',
	timeoutMs: 2500,
	allowConfidence: 0.8,
	workReject: 0.2,
	apiKeyRef: 'OPENROUTER_API_KEY',
	apiKey: ''
};

/**
 * A base URL as it is stored: trimmed, with every trailing slash removed, and
 * the empty string kept as "the shipped default". One rule for the deployment
 * config, a card edit and the client's own pre-check, so a value saved on one
 * path reads back identically on the others.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeBaseUrl(value) {
	return String(value).trim().replace(/\/+$/, '');
}

/**
 * Whether a string is an absolute http(s) URL — the only shape `askJev` can
 * POST to. An empty string is legal: it means "use the default endpoint", which
 * `askJev` already falls back to.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
	if (value === '') return true;
	try {
		const parsed = new URL(value);
		return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== '';
	} catch {
		return false;
	}
}

/**
 * The rule for one gate field: the clause to reject with, or `undefined` when
 * the value is legal. Shared by the deployment config and the settings card's
 * `/mutate`, so one place decides what a gate value may be.
 *
 * @param {string} key A key of {@link GATE_DEFAULTS}.
 * @param {unknown} value The candidate value.
 * @returns {string | undefined}
 */
function gateFieldProblem(key, value) {
	if (key === 'enabled') return typeof value === 'boolean' ? undefined : '`enabled` must be a boolean';
	if (key === 'backend') {
		return JUDGE_BACKENDS.includes(value)
			? undefined
			: `\`backend\` must be one of ${JUDGE_BACKENDS.join(', ')}`;
	}
	// The model may be the empty string: that is how a backend says "use your own
	// default route" (the session's model for `llm`, `jev-latest` for `jev`).
	if (key === 'model') return typeof value === 'string' ? undefined : '`model` must be a string';
	// The judge endpoint. Empty is legal (the shipped default), a trailing slash
	// is not an error but is stripped on the way in, and anything else has to be
	// an absolute http(s) URL — `askJev` appends `/systemone` to it.
	if (key === 'baseUrl') {
		if (typeof value !== 'string') return '`baseUrl` must be a string';
		const normalized = normalizeBaseUrl(value);
		return isHttpUrl(normalized) ? undefined : '`baseUrl` must be an absolute http(s) URL';
	}
	// The JEV judge's own key, stored in the plugin config as plain text by the
	// card's connection row. Empty is the state of a deployment that has not
	// pasted one yet — it is not a request to clear a stored key, because the card
	// never sends this field empty.
	if (key === 'apiKey') return typeof value === 'string' ? undefined : '`apiKey` must be a string';
	if (key === 'timeoutMs') {
		return Number.isSafeInteger(value) && value > 0 ? undefined : '`timeoutMs` must be a positive integer';
	}
	if (key === 'allowConfidence' || key === 'workReject') {
		const inRange = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
		return inRange ? undefined : `\`${key}\` must be a number in [0, 1]`;
	}
	return typeof value === 'string' && value !== '' ? undefined : `\`${key}\` must be a non-empty string`;
}

/**
 * Check a partial `gate` patch without filling defaults. Unknown keys, wrong
 * types, and out-of-range numbers are refused with the clause naming the field,
 * so both a failing plugin load and a rejected card edit report the same thing.
 * Only the supplied keys come back, which is what lets the settings card change
 * one field without restating the other six.
 *
 * @param {unknown} patch
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
export function validateGatePatch(patch) {
	if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
		return { ok: false, message: 'must be an object' };
	}
	const unknown = Object.keys(patch).filter((key) => !Object.hasOwn(GATE_DEFAULTS, key));
	if (unknown.length > 0) return { ok: false, message: `has unknown key(s) ${unknown.join(', ')}` };
	const value = {};
	for (const key of Object.keys(patch)) {
		const problem = gateFieldProblem(key, patch[key]);
		if (problem !== undefined) return { ok: false, message: problem };
		// Stored normalised, so the card reads back exactly what the judge will
		// POST to: no trailing slash to drift, no stray whitespace around a model id.
		if (key === 'baseUrl') value[key] = normalizeBaseUrl(patch[key]);
		else if (key === 'model' || key === 'apiKey') value[key] = patch[key].trim();
		else value[key] = patch[key];
	}
	return { ok: true, value };
}

/**
 * Validate the optional `gate` block, same strictness as the outer config:
 * unknown fields, wrong types, and out-of-range numbers all fail the load.
 *
 * @param {unknown} raw The `gate` value, already known to be present.
 * @returns {typeof GATE_DEFAULTS} A detached validated gate config.
 */
function resolveGate(raw) {
	// A composed config that names an unknown backend must not fail the plugin
	// load: drop it and land on the default, so the gate keeps working on `jev`.
	// (A settings-card patch takes the strict path below and is refused instead.)
	const patch = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.hasOwn(raw, 'backend')
		&& judgeBackend(raw.backend) !== raw.backend
		? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'backend'))
		: raw;
	const checked = validateGatePatch(patch);
	if (!checked.ok) throw new Error(`CursorPlanConfig \`gate\` ${checked.message}`);
	return { ...GATE_DEFAULTS, ...checked.value };
}

/**
 * Validate deployment config. Only the reserved `defaultSection` and the
 * optional `gate` block are accepted, so any other key fails the plugin load
 * instead of being silently ignored. `gate` is omitted from the result while
 * the deployment does not set it, so an unconfigured plugin resolves to exactly
 * what it resolved to before the gate existed.
 *
 * @param {unknown} raw Raw plugin config.
 * @returns {{ defaultSection: string, gate?: typeof GATE_DEFAULTS }} A detached validated config.
 */
export function resolveConfig(raw) {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('CursorPlanConfig must be an object — config is {}');
	}
	const unknown = Object.keys(raw).filter((key) => key !== 'defaultSection' && key !== 'gate');
	if (unknown.length > 0) {
		throw new Error(`CursorPlanConfig has unknown key(s) ${unknown.join(', ')} — config is {}`);
	}
	const defaultSection = raw.defaultSection ?? '';
	if (typeof defaultSection !== 'string') throw new Error('CursorPlanConfig `defaultSection` must be a string');
	if (raw.gate === undefined) return { defaultSection };
	return { defaultSection, gate: resolveGate(raw.gate) };
}

/**
 * Parse the `/cursor-plan` argument the way `/plan` does: only the exact word
 * `off` leaves the mode, and only `build` leaves it as an approved build. Any
 * other text, including empty, enters the mode and is the message to steer.
 *
 * @param {string} rawInput Exact text following the command name.
 * @returns {{ off: true, build: boolean } | { off: false, message: string }}
 */
export function parseModeArg(rawInput) {
	const message = typeof rawInput === 'string' ? rawInput.trim() : '';
	if (message === 'off') return { off: true, build: false };
	if (message === 'build') return { off: true, build: true };
	return { off: false, message };
}

/**
 * Id of an undelivered cursor-plan notice, otherwise undefined. Notices from
 * other plugins (the shipped `plan-mode`, `modes`) are left alone.
 *
 * The switch narration this used to match is no longer written by this plugin
 * at all (2026-10-10: dsh-mode-switch owns the one notice, on both the committed
 * and the queued path), so the sweep it feeds now only clears a line an older
 * revision left pending in a live session.
/**
 * Id of an undelivered cursor-plan notice, otherwise undefined. Notices from
 * other plugins (the shipped `plan-mode`, `modes`) are left alone.
 *
 * @param {object} message
 * @returns {string | undefined}
 */
export function planNoticeId(message) {
	const source = message?.source;
	// ponytail: v4 dropped the catch-all kind:'plugin'; producers declare their own kind.
	// Legacy (v3) and migrated (plugin:<name>) notices stay matchable so old sessions clean up.
	const kind = source?.kind;
	const own = kind === NOTICE_PLUGIN || (kind === 'plugin' && source.plugin === NOTICE_PLUGIN) || kind === 'plugin:' + NOTICE_PLUGIN;
	if (!own || source.form !== 'notice') return undefined;
	// ponytail: narration notices are ALSO role:'user' (index.js uses
	// createUserMessage), so exempt the Build click by its own summary stamp
	// instead — the test dsh-mode-switch uses to recognise a Build click.
	if (/^The user clicked Build (?:in Multi|in Default)\.$/.test(source.summary)) return undefined;
	const id = message.id;
	return id == null ? undefined : id;
}

/** Command arguments that target "off" rather than "on". */
const OFF_ARGS = new Set(['off', 'build']);

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
