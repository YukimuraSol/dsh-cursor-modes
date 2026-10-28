/**
 * The Build buttons' host half: the one message a Build click leaves behind.
 *
 * The mode half belongs to dsh-mode-switch, and the card stages it there first
 * (its pending bridge, `/stage`). This route then writes the user's decision into
 * the session with `agent.steer`, which splices the loop's own inbox and emits
 * `agent/inbox/inserted` — the exact hook dsh-mode-switch applies the staged mode
 * at, as a net change. So the mode is already committed when this message's step
 * assembles its prompt.
 *
 * Deliberately not a command. A resolved command execution appends
 * `command/run` + `command/done`, and the conversation renders that pair as a
 * persistent flow node (`dsh-commands`, `dsh-client-ui-chat`), which is the
 * receipt storm the mode control exists to avoid. A Build click therefore leaves
 * exactly one trace in the session: this message, which the model has to see anyway.
 *
 * @module dsh-cursor-plan/build
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolve, sep } from 'node:path';
import { NOTICE_PLUGIN } from './cursor-plan.js';
import { isLoopbackRequest } from './gate-settings.js';
import { markPlanDispatched, plansDir, readPlanDispatch } from './planfile.js';
import { stageBuildTodos } from './state.js';

/** Loopback bridge the two Build buttons call. */
export const BUILD_PATH = '/api/dsh-cursor-modes/build';

/**
 * Loopback read of one plan's dispatch stamp. The card asks this on mount, so a
 * plan that was already built comes back showing Dispatched instead of the two
 * buttons - across reloads, reopened sessions and other browsers.
 */
export const PLAN_STATE_PATH = '/api/dsh-cursor-modes/plan-state';

/**
 * Whether a client-supplied path is a plan file this plugin is allowed to touch.
 * The card passes the path the host itself embedded as `Plan file: <path>`, so
 * the only real job here is refusing everything outside `<plansDir>/`: no
 * traversal, no arbitrary reads, no writes anywhere else.
 *
 * @param {unknown} candidate the `path` query value.
 * @returns {string | undefined} the resolved absolute path, or undefined.
 */
export function planPathOf(candidate) {
	if (typeof candidate !== 'string' || candidate === '') return undefined;
	if (!candidate.endsWith('.plan.md')) return undefined;
	let root;
	try {
		root = resolve(plansDir());
	} catch {
		return undefined;
	}
	const abs = resolve(candidate);
	if (!abs.startsWith(root + sep)) return undefined;
	return abs;
}

/**
 * Button choice → the mode id dsh-mode-switch stages for it. The card keeps its
 * own copy because staging happens before this route is even called.
 */
export const BUILD_TARGETS = Object.freeze({ multi: 'multi', default: 'default' });

/** Button choice → the label printed on the button the user pressed. */
export const BUILD_LABELS = Object.freeze({ multi: 'Build in Multi', default: 'Build in Default' });

/** One bridge body cap: a session id, a choice, and the plan's checklist. */
const MAX_JSON_BODY_BYTES = 8192;

/**
 * The statuses `todo_write` accepts. Wider than the projection for nothing:
 * the kernel's `todos` unit only carries these three, so a fourth would fail the
 * wire read rather than reach the list.
 */
const TODO_STATUSES = ['pending', 'in_progress', 'completed'];

/**
 * The plan's checklist, reduced to what `todo_write` takes: `content` +
 * `status`, no `id` (a planning handle the session list does not carry).
 *
 * `undefined`/`null` is the normal case — a simple plan has no checklist — and
 * means "nothing to write". A malformed list returns `undefined` from the
 * caller's view (see below) so a partial write never lands.
 *
 * @param {unknown} raw The optional `todos` field of the bridge body.
 * @returns {Array<{ content: string, status: string }> | undefined} `undefined` when malformed.
 */
export function normalizeBuildTodos(raw) {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) return undefined;
	const todos = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) return undefined;
		const content = typeof item.content === 'string' ? item.content.trim() : '';
		if (content === '') return undefined;
		// A cancelled plan item is not part of the work list at all.
		if (item.status === 'cancelled') continue;
		if (!TODO_STATUSES.includes(item.status)) return undefined;
		todos.push({ content, status: item.status });
	}
	return todos;
}

/** What a settled Build click tells the model. */
const BUILD_INSTRUCTION = 'Implement the plan as specified.'
	+ ' The plan file is in your context history; the plan body is NOT.'
	+ ' Read it before you start, do NOT edit the plan file itself, and do NOT create a new plan'
	+ ' — the plan file stays for reference.';

/**
 * The tail only "Build in Multi" carries. Multi is the Build that ends in
 * delegation, so its extra sentences say how the plan is handed over: the worker
 * gets the path, the slice it owns and its own slice of the checklist (through
 * the `subagent` tool's `todos` argument), reads the plan file itself, and never
 * receives a copy of the plan body. The last sentence keeps the checklist out of
 * this conversation for the same reason: the workers do the work, the main thread
 * only assigns it. The leading space is what makes it render as one more sentence
 * pinned to BUILD_INSTRUCTION — which "Build in Default" still emits alone,
 * unchanged.
 */
const PLAN_HANDOFF = ' When you delegate, give each worker the plan file path, the part it owns,'
	+ ' and its own slice of the checklist as the subagent `todos` argument — and have it read the plan file itself;'
	+ ' never paste the plan body into a worker prompt.'
	+ ' Keep the checklist in the workers\' hands: do not write your own todo list in this conversation'
	+ ' — the main thread assigns work and reports back.';

/**
 * The message text a Build click writes. One restrained opening line names the
 * button — that is the whole point, the model has to see which Build was pressed
 * — and the rest is the instruction the retired `/cursor-plan build` steered
 * with, so a click still means "leave planning and implement".
 *
 * The two buttons no longer share one identical text: the shared base above is
 * verbatim for both, and "Build in Multi" appends PLAN_HANDOFF. Default's output
 * stays byte-for-byte what it always was.
 *
 * @param {'multi' | 'default'} choice
 * @returns {string}
 */
export function buildText(choice) {
	return `The user clicked "${BUILD_LABELS[choice]}". ${BUILD_INSTRUCTION}`
		+ (choice === 'multi' ? PLAN_HANDOFF : '');
}

/**
 * One Build click, as the loop wants to receive it: role `user` (dsh-mode-switch
 * only applies a staged mode to the user's own prompt) and stamped as this
 * plugin's notice, the same shape the command path used.
 *
 * @param {'multi' | 'default'} choice
 * @returns {object} the user message to steer into the session.
 */
export function buildMessage(choice) {
	return createUserMessage({
		content: [{ type: 'text', text: buildText(choice) }],
		source: { kind: NOTICE_PLUGIN, form: 'notice', summary: `The user clicked ${BUILD_LABELS[choice]}.` }
	});
}

/** One JSON response; a refusal is a body with a `code`, never a transport error. */
function writeJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
	res.end(JSON.stringify(body));
}

/** The parsed request body, or `undefined` for a malformed or oversized one. */
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

/**
 * Build the bridge route — one exact POST path, loopback-only. It never switches
 * the mode and never executes a command: the mode was staged by the card and the
 * message below is the only thing this route adds.
 *
 * @param {{ get: (sessionId: string) => object | undefined }} agents The live agent registry.
 * @param {ReturnType<import('./state.js').createState>} state the single state bag. A
 *   default Build's checklist is STAGED here; nothing is appended from this route.
 * @returns {Array<{ kind: string, path: string, handler: Function }>}
 */
export function makeBuildRoutes(agents, state) {
	return [{
		kind: 'exact',
		path: BUILD_PATH,
		handler: async (req, res) => {
			if (!isLoopbackRequest(req)) {
				writeJson(res, 403, { ok: false, code: 'loopback-only', message: 'loopback requests only' });
				return;
			}
			if (req.method !== 'POST') {
				writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'method not allowed: ' + String(req.method ?? '') });
				return;
			}
			const body = await readJsonBody(req);
			if (body === undefined || typeof body !== 'object' || body === null || Array.isArray(body)) {
				writeJson(res, 400, { ok: false, code: 'malformed-request', message: 'a JSON object body is required' });
				return;
			}
			const sessionId = body.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') {
				writeJson(res, 400, { ok: false, code: 'malformed-request', message: 'sessionId must be a non-empty string' });
				return;
			}
			const choice = body.choice;
			if (typeof choice !== 'string' || !Object.hasOwn(BUILD_TARGETS, choice)) {
				writeJson(res, 400, { ok: false, code: 'unknown-choice', message: 'choice must be one of ' + Object.keys(BUILD_TARGETS).join(', ') });
				return;
			}
			// The checklist is validated before the agent lookup: a malformed list
			// is the caller's bug, not a missing session, and the 400 says so.
			const todos = normalizeBuildTodos(body.todos);
			if (todos === undefined) {
				writeJson(res, 400, { ok: false, code: 'malformed-todos', message: 'todos must be an array of { content, status }' });
				return;
			}
			// The plan file is optional (an older client sends none) but, when sent,
			// it must be one of OUR plan files and it is validated before anything is
			// steered: a bad path refuses the click instead of half-applying it.
			let planFile;
			if (body.planFile !== undefined && body.planFile !== null && body.planFile !== '') {
				planFile = planPathOf(body.planFile);
				if (planFile === undefined) {
					writeJson(res, 400, { ok: false, code: 'invalid-plan-path', message: 'planFile must be a plan file under ' + plansDir() });
					return;
				}
			}
			// A session with no live agent cannot be handed a message, and replying
			// ok there would leave the card believing a build started.
			const agent = agents?.get?.(sessionId);
			if (agent === undefined) {
				writeJson(res, 409, { ok: false, code: 'session-not-live', message: 'no live agent for session ' + sessionId });
				return;
			}
			try {
				// Where the approved checklist goes depends on WHO does the work
				// (2026-10-24):
				//
				//  * "Build in Default" — this conversation's own agent implements the
				//    plan, so the list belongs here, visible for its whole turn. It is
				//    STAGED, not appended: a click lands while the session is idle, and
				//    the message below opens the next turn, whose `turn/start` clears
				//    the kernel's `todos` projection in the same breath. The one
				//    `agent/pre-step` writes it instead, inside that turn (see
				//    state.js commitBuildTodos — the window dsh-subagent's
				//    `attachInitialTodos` uses). An append made here showed the list
				//    for one frame and then it was gone.
				//
				//  * "Build in Multi" — the workers do the work, and each one gets its
				//    slice through the `subagent` tool's own `todos` argument. This
				//    conversation keeps the notice and gets no dock: a list here would
				//    describe work nobody in this session is doing.
				//
				// `id` is dropped either way: `todo_write` takes content + status only.
				if (choice === 'default' && todos.length > 0) stageBuildTodos(state, sessionId, todos);
				agent.steer(buildMessage(choice));
			} catch (error) {
				writeJson(res, 500, { ok: false, code: 'steer-failed', message: error instanceof Error ? error.message : String(error) });
				return;
			}
			// The dispatch stamp lands in the plan file's frontmatter AFTER the message
			// is in the inbox: the card must never show a permanent Dispatched for a
			// build that never started. A failed write is reported, not fatal - the
			// build did start, only its receipt is missing.
			let dispatched = false;
			let dispatchError;
			if (planFile !== undefined) {
				try {
					markPlanDispatched(planFile, choice);
					dispatched = true;
				} catch (error) {
					dispatchError = error instanceof Error ? error.message : String(error);
					console.warn('[dsh-cursor-modes] build started but the plan dispatch stamp was not written: %s', dispatchError);
				}
			}
			writeJson(res, 200, {
				ok: true,
				value: {
					sessionId,
					choice,
					mode: BUILD_TARGETS[choice],
					dispatched,
					...dispatchError === undefined ? {} : { dispatchError }
				}
			});
		}
	}, {
			kind: 'exact',
			path: PLAN_STATE_PATH,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { ok: false, code: 'loopback-only', message: 'loopback requests only' });
					return;
				}
				if (req.method !== 'GET') {
					writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'method not allowed: ' + String(req.method ?? '') });
					return;
				}
				let url;
				try {
					url = new URL(req.url ?? '/', 'http://127.0.0.1');
				} catch {
					writeJson(res, 400, { ok: false, code: 'malformed-request', message: 'unreadable request url' });
					return;
				}
				const planFile = planPathOf(url.searchParams.get('path'));
				if (planFile === undefined) {
					writeJson(res, 400, { ok: false, code: 'invalid-plan-path', message: 'path must be a plan file under ' + plansDir() });
					return;
				}
				const value = readPlanDispatch(planFile);
				if (value.invalid !== undefined) {
					console.warn('[dsh-cursor-modes] invalid dispatched value in %s: %s', planFile, value.invalid);
				}
				writeJson(res, 200, { ok: true, value });
			}
		}];
}
