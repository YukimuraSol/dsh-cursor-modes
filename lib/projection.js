/**
 * The one merged session-mode projection (blueprint Step 4).
 *
 * Two legacy plugins each folded its own log stream into its own projection:
 *
 *   dsh-cursor-plan  `cursorPlan`  <- `cursorPlan/state`  (plan latch)
 *   dsh-modes        `mode`        <- `mode/selected`    (multi latch)
 *
 * Both had the *same* projection key `mode` for the multi plugin and a separate
 * key for plan, so a session that used both modes ended up with two independent
 * latches that no single fold could reconstruct ("seq 最大者赢" got 9 sessions
 * wrong). This module owns ONE projection, key `mode`, stateVersion 4, holding
 * BOTH latches plus the derived single `mode`.
 *
 * ## Boundary discipline
 *
 * `projection.js` is the ONLY file in this plugin that knows the event names:
 * the three legacy streams, the pre-0.2.3 committed-mode event
 * (`cursormodes/state`) and the plugin record written since
 * (`plugin:cursormodes/state`). Every other module speaks the latches. When the
 * compatibility window closes, deleting the legacy branches here — plus
 * `registerModeEventTypes`'s legacy loop and `tools/legacy-fold.mjs` /
 * `self-check-fold.mjs` — is the whole migration. Do not let a legacy name leak
 * past this file.
 *
 * @module dsh-cursor-modes/projection
 */

import { createRequire } from 'node:module';
import { z } from 'zod';
import { sessionModuleFromArgv, registerEventType } from './cursor-plan.js';

/** Projection key. Kept as `mode` so the client chip and the old key agree. */
export const MODE_KEY = 'mode';

/** Projection state version. 3 was `dsh-modes`'s single-value shape; 4 adds the plan latch. */
export const MODE_STATE_VERSION = 4;

/**
 * The committed-mode event older logs carry and this revision still reads.
 *
 * 0.2.1 and earlier wrote it through `session.append`, which stamps no
 * `ignorable` marker: the host then refuses the WHOLE log on restore once this
 * plugin is uninstalled (only its load-time `registerEventType` kept the type in
 * the live vocabulary Set). The name stays here for exactly two jobs — reading
 * those logs back, and keeping them registered while this version is installed.
 */
export const MODE_EVENT = 'cursormodes/state';

/**
 * The committed-mode PLUGIN RECORD written since 0.2.3.
 *
 * `appendPluginRecord` is the host's supported path for an external plugin
 * (blueprint §3.4): the type must be `plugin:` plus lowercase slash-separated
 * segments, and the record is stamped `ignorable: true`, so a reader that does
 * not know the type keeps the record and skips it instead of refusing the log.
 * That marker is the whole point: this name needs no `registerEventType` and
 * survives this plugin being uninstalled.
 *
 * Deliberately ALL LOWERCASE: `dsh-session`'s
 * `PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u`
 * admits no capitals, so every legacy name (they carry a capital `P`) would be
 * rejected as a plugin record. `foldMode` strips the `plugin:` prefix, which is
 * what makes this record fold exactly like {@link MODE_EVENT}.
 */
export const MODE_RECORD = 'plugin:cursormodes/state';

/** Legacy plan-stream event (dsh-cursor-plan). Must stay registered to read old logs. */
export const LEGACY_PLAN_EVENT = 'cursorPlan/state';

/** Legacy plan-document event (dsh-cursor-plan). Does NOT participate in the mode fold. */
export const LEGACY_PLAN_DOC_EVENT = 'cursorPlan/planDoc';

/** Legacy multitask-stream event (dsh-modes). Must stay registered to read old logs. */
export const LEGACY_MULTI_EVENT = 'mode/selected';

/** Plan body event, carried over verbatim — no new name, the client fold already reads it. */
export const PLAN_DOC_EVENT = 'cursorPlan/planDoc';

const Mode = z.enum(['default', 'plan', 'multi']);
const Target = z.enum(['plan', 'multi', 'off']);

/**
 * Why two boolean latches instead of a single `mode`:
 *
 * The old logs are two INDEPENDENT event streams, and 12 sessions were measured
 * with both open at once. A single-value fold loses `multi` the moment a
 * `cursorPlan/state{null}` arrives after `mode/selected{multi}` — that is exactly
 * the mechanism behind the 9 sessions "seq 最大者赢" got wrong. Only two latches
 * replay faithfully; `mode` is a derived value, not the source of truth.
 */
export const modeStateSchema = z.object({
	plan: z.boolean(), // plan latch (legacy stream folded independently)
	multi: z.boolean(), // multi latch
	mode: Mode, // derived: plan ? 'plan' : multi ? 'multi' : 'default'
	modeAtHeader: Mode,
	wanted: z.union([z.literal(true), z.null()]), // true = a switch is in flight
	running: z.union([z.object({ commandId: z.string(), target: Target }), z.null()])
});

export const modeInit = () => ({
	plan: false,
	multi: false,
	mode: 'default',
	modeAtHeader: 'default',
	wanted: null,
	running: null
});

/** Strip the `plugin:` prefix a v3->v4 migration puts on non-native record types. */
const stripPluginPrefix = (t) =>
	typeof t === 'string' && t.startsWith('plugin:') ? t.slice(7) : t;

const derive = (plan, multi) => (plan ? 'plan' : multi ? 'multi' : 'default');

export function foldMode(state, event) {
	const type = stripPluginPrefix(event?.type);
	const data = event?.data;

	// —— 老流 1：计划模式（两种 type 字符串都要认）
	if (type === LEGACY_PLAN_EVENT) {
		const plan = data?.mode === 'plan';
		return { ...state, plan, mode: derive(plan, state.multi), wanted: null };
	}

	// —— 老流 2：多任务模式
	if (type === LEGACY_MULTI_EVENT) {
		const multi = data?.mode === 'multi';
		return { ...state, multi, mode: derive(state.plan, multi), wanted: null };
	}

	// —— 新流：单值显式设定（两个 latch 互斥，新写入永远是「净变更」语义）
	// 0.2.3 writes `plugin:cursormodes/state`; the strip above is what sends it
	// into this same branch as the old `cursormodes/state`, so the two names fold
	// identically and no legacy log changes meaning.
	if (type === MODE_EVENT) {
		const mode = data?.mode === 'plan' ? 'plan' : data?.mode === 'multi' ? 'multi' : 'default';
		return { ...state, plan: mode === 'plan', multi: mode === 'multi', mode, wanted: null };
	}

	// —— 命令排队（/cursor-plan 与 /cursor-multi 共用）
	if (type === 'command/run') {
		const name = data?.name;
		if (name !== 'cursor-plan' && name !== 'cursor-multi') return state;
		const args = String(data?.args ?? '').trim();
		const target = name === 'cursor-plan'
			? (args === 'off' || args === 'build' ? 'off' : 'plan')
			: (args === 'off' ? 'off' : 'multi');
		return { ...state, running: { commandId: String(data?.commandId ?? ''), target } };
	}

	if (type === 'command/done') {
		const running = state.running;
		if (!running || String(data?.commandId ?? '') !== running.commandId) return state;
		const turningOff = running.target === 'off';
		const wanted = data?.kind === 'success'
			&& (turningOff ? state.mode !== 'default' : running.target !== state.mode);
		return { ...state, wanted: wanted ? true : null, running: null };
	}

	// —— 回合边界：记住「本轮开头的模式」，供提示词判断是入场还是续写
	if (type === 'request/header') {
		return state.modeAtHeader === state.mode ? state : { ...state, modeAtHeader: state.mode };
	}

	// —— planDoc 不参与模式 fold（plan 卡有独立的前端 fold），必须显式返回原 state
	if (type === LEGACY_PLAN_DOC_EVENT) return state;

	return state;
}

export function modeView(state) {
	return { mode: state.mode, pending: state.wanted === true };
}

export const modeProjectionDefinition = {
	key: MODE_KEY,
	stateVersion: MODE_STATE_VERSION,
	stateSchema: modeStateSchema,
	init: () => modeInit(),
	apply: foldMode,
	wire: {
		viewSchema: z.object({ mode: Mode, pending: z.boolean() }),
		view: modeView
	}
};

/**
 * The four event types that must join the host's live vocabulary Set, or every
 * log written before 0.2.3 fails to open. LOAD ORDER, not a matter of taste.
 *
 * `dsh-session`'s `KNOWN_SESSION_EVENT_TYPES` is a hard-coded whitelist of 60
 * native types and contains none of these four. A process that did not `add()`
 * them throws out of `restoreReleasedV4Artifact` while opening the log:
 *
 *     format v4 contains unknown event type "cursorPlan/state" at seq 2255
 *
 * (Those logs were written by `session.append` WITHOUT `ignorable`, so an
 * unregistered type is a hard failure, not a skip. Note the number in that
 * v4 message is the ARRAY INDEX; the v3 migration message carries `event.seq`
 * instead — that wording difference is the only clue which stage blew up.)
 *
 * {@link MODE_RECORD} is deliberately NOT here: it carries `ignorable: true` on
 * the event itself, so it needs no registration and a host without this plugin
 * still opens the log. Registering it would hide the very read-path behaviour the
 * plugin record exists to earn.
 */
export const MODE_EVENT_TYPES = Object.freeze([
	MODE_EVENT,
	LEGACY_PLAN_EVENT,
	LEGACY_PLAN_DOC_EVENT,
	LEGACY_MULTI_EVENT
]);

const requireFromHere = createRequire(import.meta.url);

/**
 * Load the host's `dsh-session` module. Must be SYNCHRONOUS: this runs in the
 * plugin's top-level `apply`, before any `ctx.inject` callback, and a top-level
 * `await import()` would put an await in the plugin body.
 *
 * Resolution order, first hit wins:
 *
 * 1. `sessionModuleFromArgv(process.argv)` — the path derived from the running
 *    `dsh` bin, the exact one the host itself loaded.
 * 2. Bare specifier `@deepseek-ai/dsh-session` through this file's own resolver —
 *    for the self-check and for launches that do not expose the bin in argv.
 *
 * Both go through `createRequire`, so Node returns the SAME module instance the
 * host has (verified: the `KNOWN_SESSION_EVENT_TYPES` Set identity matches), and
 * `add()` therefore mutates the live Set rather than a private copy.
 *
 * This is the one file allowed to do this; see the module docblock.
 */
function loadSessionModule(argv) {
	const fromArgv = sessionModuleFromArgv(argv);
	if (fromArgv !== undefined) {
		try {
			return requireFromHere(fromArgv);
		} catch {
			// fall through to the bare specifier — mirrors --preserve-symlinks launches
		}
	}
	return requireFromHere('@deepseek-ai/dsh-session');
}

/**
 * Register every legacy event type this projection folds in the host's live
 * vocabulary Set.
 *
 * @param {readonly string[]} [argv] `process.argv`; defaults to the live one.
 * @returns {string[]} the types registered (for the self-check to report).
 */
export function registerModeEventTypes(argv = process.argv) {
	const known = loadSessionModule(argv).KNOWN_SESSION_EVENT_TYPES;
	for (const type of MODE_EVENT_TYPES) registerEventType(known, type);
	return [...MODE_EVENT_TYPES];
}

/**
 * Injectable mode-record writer, used ONLY by the self-checks. Their fake
 * Sessions are plain objects and cannot receive the host's module-private
 * `Session#appendRecord`; the seam lets them observe the exact type and payload
 * the shipped writer passes. `undefined` is the shipped path.
 */
let modeRecordAppend;

/**
 * Swap the mode-record writer (self-checks only; `undefined` restores the
 * shipped path). Not a runtime knob: nothing in `lib/` calls it.
 *
 * @param {((session: object, type: string, data: object) => unknown) | undefined} append
 */
export function setModeEventAppend(append) {
	modeRecordAppend = append;
}

/**
 * Append the committed mode as ONE `ignorable` plugin record.
 *
 * `appendPluginRecord` publishes through a module-private `Session#appendRecord`,
 * so the call has to run against the host's OWN copy of `dsh-session` — the same
 * instance {@link registerModeEventTypes} resolves. `session.append(type, data)`
 * is exactly the wrong call here: it stamps no `ignorable` marker, and a log
 * carrying such an unknown type is refused on restore once this plugin is
 * uninstalled (the bug 0.2.3 replaced).
 *
 * @param {object} session the live (or detached) host Session.
 * @param {string} mode `'default' | 'plan' | 'multi'`.
 * @param {readonly string[]} [argv] `process.argv`; defaults to the live one.
 * @returns {number | undefined} the committed record's seq.
 */
export function appendModeEvent(session, mode, argv = process.argv) {
	if (typeof modeRecordAppend === 'function') return modeRecordAppend(session, MODE_RECORD, { mode });
	const { appendPluginRecord } = loadSessionModule(argv);
	if (typeof appendPluginRecord !== 'function') {
		throw new Error('dsh-cursor-modes: the host dsh-session does not export appendPluginRecord');
	}
	return appendPluginRecord(session, MODE_RECORD, { mode });
}

/*
 * ## `pending` 语义变更说明 (blueprint §3.2, mandatory)
 *
 * 老 `cursorPlanView` / 老 `modeView` 都是
 * `pending: wanted !== null && wanted !== active`，
 * 其中 `wanted` 是 `true | false | null`（`false` 表示「排队关闭」）。
 *
 * 新实现把 `wanted` 收成 `true | null`：
 *   - `true`  = 有一次切换在飞，方向由 `running.target` 决定；
 *   - `null`  = 没有在飞的切换。
 * 于是 `pending = wanted === true`。
 *
 * 两种写法在前端只影响 `pending` 布尔值，实测等价（见 §3.5 的 `pending` 断言）。
 * 换句话说：老的「方向」信息没有被丢掉，它搬到了 `running.target` 里；
 * `wanted` 现在只回答「有没有切换在飞」这一个问题。
 */
