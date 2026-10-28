/**
 * The plugin's whole HTTP surface: eight exact POST routes under one prefix.
 *
 *   POST /api/dsh-cursor-modes/build                 ← build.js      makeBuildRoutes
 *   POST /api/dsh-cursor-modes/settings/describe     ← gate-settings.js makeGateRoutes
 *   POST /api/dsh-cursor-modes/settings/mutate       ← gate-settings.js makeGateRoutes
 *   POST /api/dsh-cursor-modes/settings/status       ← gate-settings.js makeGateRoutes
 *   POST /api/dsh-cursor-modes/switch/stage          ← this file
 *   POST /api/dsh-cursor-modes/switch/clear          ← this file
 *   POST /api/dsh-cursor-modes/switch/self-test      ← this file (dev tool: mints a session)
 *   POST /api/dsh-cursor-modes/switch/vocabulary      ← this file (diagnostics)
 *
 * Three of the four families are NOT reimplemented here: \`build.js\` and
 * \`gate-settings.js\` already own their routes and their validation chains
 * (403 non-loopback → 405 → 400 → 409 → 500 for build; 403 → 405 → 400 for
 * settings), so this file only concatenates them. Only the four switch routes
 * are built here, from \`dsh-mode-switch/lib/index.js\`'
 * \`makeBridgeRoutes\` / \`makeSelfTestRoute\` / \`vocabularyRoute\`.
 *
 * **The old prefixes are gone** (blueprint §4.4): a tree-wide grep found no
 * external consumer of \`/api/dsh-cursor-plan-build\`,
 * \`/api/dsh-cursor-plan-settings\` or \`/api/dsh-mode-switch\` — the one
 * near-miss, \`dsh-colombia-skin/tools/chrome_token_probe.cjs\`, regex-matches
 * \`/cursor-plan/\` against page innerText and makes no request. Keeping the old
 * paths would be eight routes that can never 404, plus a doubled assertion table
 * in \`self-check-bridge.mjs\`.
 *
 * Every route is \`kind: 'exact'\` and POST-only, and every handler answers a JSON
 * object — a refusal is a body carrying a \`code\`, never a transport error.
 *
 * @module dsh-cursor-modes/routes
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { makeBuildRoutes } from './build.js';
import { GATE_BRIDGE_PREFIX, isLoopbackRequest, makeGateRoutes } from './gate-settings.js';
import { MODE_EVENT_TYPES, registerModeEventTypes } from './projection.js';
import { BRIDGE_PREFIX, MODE_IDS, asModeId, selfTestSteps } from './switch.js';

/**
 * The switch family's prefix, re-exported because \`self-check-pending-retire.mjs\`
 * imports \`BRIDGE_PREFIX\` from this module (blueprint §6.3). One definition, in
 * \`switch.js\`; this is the same binding, not a second copy.
 */
export { BRIDGE_PREFIX };

/** The common prefix of all eight routes (blueprint §4.4). */
export const ROUTES_PREFIX = '/api/dsh-cursor-modes';

/** One bridge body cap; a staged selection is two short strings. */
const MAX_JSON_BODY_BYTES = 8192;

/** One JSON response; a refusal is a body with a \`code\`, never a transport error. */
function writeJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
	res.end(JSON.stringify(body));
}

/** The parsed request body, or \`undefined\` for a malformed or oversized one. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_JSON_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return undefined;
	}
}

/** The two guards every route in this file shares: loopback, then POST. */
function guard(req, res) {
	if (!isLoopbackRequest(req)) {
		writeJson(res, 403, { ok: false, code: 'loopback-only', message: 'loopback requests only' });
		return false;
	}
	if (req.method !== 'POST') {
		writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'method not allowed: ' + String(req.method ?? '') });
		return false;
	}
	return true;
}

/**
 * The \`{sessionId, body}\` a staged-selection body has to carry, or \`undefined\`
 * after the reply was already written.
 */
async function acceptSession(req, res) {
	if (!guard(req, res)) return undefined;
	const body = await readJsonBody(req);
	if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
		writeJson(res, 400, { ok: false, code: 'malformed-request', message: 'a JSON object body is required' });
		return undefined;
	}
	const sessionId = body.sessionId;
	if (typeof sessionId !== 'string' || sessionId === '') {
		writeJson(res, 400, { ok: false, code: 'malformed-request', message: 'sessionId must be a non-empty string' });
		return undefined;
	}
	return { sessionId, body };
}

/**
 * \`/stage\` and \`/clear\`: the chip's pending selection, and nothing else.
 *
 * Neither route executes a command, appends a session event, or touches the
 * model — they only move one entry of \`state.pending\`, which is the merged
 * replacement for the old module-level \`staged\` Map (blueprint §2.2, item 3).
 * The value shape is \`{ mode, at, origin: 'bridge' }\`; a route holds a
 * session id and no \`Session\` object, which is exactly why
 * \`state.pending\` is a \`Map\` keyed by that id rather than a \`WeakMap\`.
 *
 * \`state.js\` names itself the only writer of \`state.pending\`; that rule is
 * about the *shape* of the value (one vocabulary, one origin field) and cannot
 * be met by an API that takes no agent. These two handlers are the single
 * documented exception — blueprint §2.2 lists \`POST …/stage\` as pending's
 * second writer by name.
 *
 * @param {ReturnType<import('./state.js').createState>} state
 * @returns {Array<{ kind: string, path: string, handler: Function }>}
 */
export function makePendingRoutes(state) {
	return [
		{
			kind: 'exact',
			path: BRIDGE_PREFIX + '/stage',
			handler: async (req, res) => {
				const accepted = await acceptSession(req, res);
				if (accepted === undefined) return;
				// Both value domains: a browser may still be running the previous
				// client's JS, which posts 'cursorPlan'/'cursorMulti' (§4.4).
				const target = asModeId(accepted.body.target);
				if (target === undefined) {
					writeJson(res, 200, { ok: false, code: 'unknown-mode', message: 'target must be one of ' + MODE_IDS.join(', ') });
					return;
				}
				state.pending.set(accepted.sessionId, { mode: target, at: Date.now(), origin: 'bridge' });
				writeJson(res, 200, { ok: true, value: { sessionId: accepted.sessionId, target } });
			}
		},
		{
			kind: 'exact',
			path: BRIDGE_PREFIX + '/clear',
			handler: async (req, res) => {
				const accepted = await acceptSession(req, res);
				if (accepted === undefined) return;
				state.pending.delete(accepted.sessionId);
				writeJson(res, 200, { ok: true, value: { sessionId: accepted.sessionId, target: null } });
			}
		}
	];
}

/**
 * The four mode event types, as the live session vocabulary knows them.
 *
 * \`registerModeEventTypes\` is idempotent (\`Set.add\`) and returns the list it
 * registered; when it throws, the host module was not loadable from this
 * package, so the membership is genuinely unknown and reported as \`null\`
 * rather than guessed. The four KEYS are always present — that is what
 * \`self-check-bridge.mjs\` asserts (§4.4).
 *
 * @returns {Record<string, boolean | null>}
 */
function vocabularyKnows() {
	let registered = null;
	try {
		registered = registerModeEventTypes();
	} catch {
		registered = null;
	}
	return Object.fromEntries(MODE_EVENT_TYPES.map((type) => [type, registered === null ? null : registered.includes(type)]));
}

/**
 * A loopback self-test: mint a fresh session, stage a mode, and steer a short
 * user message — the same path a mode-control click takes, so \`state.lastCommit\`
 * answers whether a real send committed the staged mode. It cannot touch an
 * existing session: the session id is always generated here, never accepted.
 *
 * @param {object} context the live context carrying \`agents\`
 * @param {ReturnType<import('./state.js').createState>} state
 * @returns {{ kind: string, path: string, handler: Function }}
 */
export function makeSelfTestRoute(context, state) {
	return {
		kind: 'exact',
		path: BRIDGE_PREFIX + '/self-test',
		handler: async (req, res) => {
			if (!guard(req, res)) return;
			const body = await readJsonBody(req);
			if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
				writeJson(res, 400, { ok: false, code: 'malformed-request', message: 'a JSON object body is required' });
				return;
			}
			const agents = context.agents;
			if (agents === undefined || typeof agents.create !== 'function') {
				writeJson(res, 503, { ok: false, code: 'no-agents', message: 'the agents service is not reachable from this context' });
				return;
			}
			const { randomUUID } = await import('node:crypto');
			const steps = [];
			try {
				const options = {
					sessionId: 'session-' + randomUUID(),
					meta: { cwd: body.cwd === undefined ? process.cwd() : body.cwd }
				};
				if (body.agentOptions !== undefined) options.agentOptions = body.agentOptions;
				const handle = await agents.create(options);
				const agent = handle.agent;
				for (const step of selfTestSteps(body.steps)) {
					state.pending.set(agent.session.id, { mode: step.target, at: Date.now(), origin: 'bridge' });
					state.lastCommit = null;
					// \`kind: 'user'\` is what a real send carries
					// (dsh-api-session-controller/lib/index.js:856), and this route
					// exists precisely to exercise "the same path a mode-control
					// click takes" — so it has to wear the same stamp to be admitted
					// by \`commitPending\`'s S1 condition (a message with no source is
					// admitted too, but the self-test should look like a real send).
					agent.steer(createUserMessage({
						content: [{ type: 'text', text: step.text }],
						source: { kind: 'user', form: 'self-test' }
					}));
					await new Promise((resolve) => setTimeout(resolve, step.waitMs));
					steps.push({ target: step.target, measured: state.lastCommit });
				}
				writeJson(res, 200, { ok: true, sessionId: agent.session.id, steps, hook: state.lastCommit });
			} catch (error) {
				writeJson(res, 500, {
					ok: false, code: 'self-test-failed',
					message: String(error && error.message !== undefined ? error.message : error),
					steps, hook: state.lastCommit
				});
			}
		}
	};
}

/**
 * Diagnostics: what the live process knows, and the last mode this plugin
 * committed at a step start. The old route joined a vocabulary here; that job
 * moved to \`projection.registerModeEventTypes\`, so this one only reports.
 *
 * @param {ReturnType<import('./state.js').createState>} state the single state bag.
 * @returns {{ kind: string, path: string, handler: Function }}
 */
export function vocabularyRoute(state) {
	return {
		kind: 'exact',
		path: BRIDGE_PREFIX + '/vocabulary',
		handler: async (req, res) => {
			if (!guard(req, res)) return;
			writeJson(res, 200, {
				ok: true,
				hook: state.lastCommit,
				knows: vocabularyKnows()
			});
		}
	};
}

/**
 * Build all eight routes.
 *
 * @param {object} context the live context. \`agents\` feeds the build route and
 * the self-test; \`settings\` and the three gate hooks feed the settings family.
 * @param {object} [context.settings] the live \`settings\` service.
 * @param {() => object} [context.gate] reads the effective gate values.
 * @param {{ last: object | null }} [context.verdicts] the in-memory last judge outcome.
 * @param {() => Promise<{ ref: string, configured: boolean }>} [context.credential]
 * whether the named credential reference resolves.
 * @param {ReturnType<import('./state.js').createState>} state the single state bag.
 * @returns {Array<{ kind: string, path: string, handler: Function }>} exactly 8.
 */
export function makeSwitchRoutes(context, state) {
	return [
		// 5-6: /switch/stage, /switch/clear
		...makePendingRoutes(state),
		// 7: /switch/self-test
		makeSelfTestRoute(context, state),
		// 8: /switch/vocabulary
		vocabularyRoute(state)
	];
}

export function makeRoutes(context, state) {
	return [
		// 1: /build
		...makeBuildRoutes(context.agents, state),
		// 2-4: /settings/describe, /mutate, /status
		...makeGateRoutes(context.settings, {
			gate: () => (typeof context.gate === 'function' ? context.gate() : {}),
			verdicts: context.verdicts ?? { last: null },
			credential: () => (typeof context.credential === 'function' ? context.credential() : Promise.resolve({ ref: '', configured: false }))
		}),
		// 5-8: the switch family
		...makeSwitchRoutes(context, state)
	];
}
