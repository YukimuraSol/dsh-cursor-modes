#!/usr/bin/env node
// self-check-bridge.mjs — the merged plugin's HTTP surface and its one switch hook.
//
// Absorbs five retired self-checks (blueprint 6.2):
//   dsh-cursor-plan/self-check-settings-bridge.mjs -> the Config projection + gate bridge
//   dsh-cursor-plan/self-check-buildbuttons.mjs    -> the two Build buttons, host + client
//   dsh-cursor-plan/self-check-gzip-gate.mjs       -> askJev eats a gzip judge answer
//   dsh-mode-switch/self-check-mode-switch.mjs     -> netChange / notices / submit / apply
//   dsh-mode-switch/self-check-pending-retire.mjs  -> the chip's staged choice retires
//
// Node straight up, no framework. Every assertion is written to fail for a
// specific reason, not merely to be true today:
//
//   * the route table is compared against the NINE paths by name, so a route
//     that silently disappears (or arrives under the retired prefix) is a
//     failure rather than a shorter list;
//   * every refusal branch is driven through the real handler with a fake
//     IncomingMessage, so the status code and body shape are the shipped ones,
//     not a paraphrase;
//   * the value domain is exercised from BOTH alphabets (plan/multi and the
//     retired cursorPlan/cursorMulti), because a browser still running the old
//     client posts the old ids;
//   * the client half is skipped — never failed — when lib/client.js has not
//     been written yet, because that file is another owner's deliverable.
//
// Usage: node self-check-bridge.mjs   (from this directory)
// Exit 0 with "self-check-bridge: N passed, 0 failed"; exit 1 on any failure.

import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(new URL(rel, import.meta.url).href);

// A literal backtick, kept out of the template literals in this file so the
// assertion messages stay readable instead of triple-escaped.
const BT = String.fromCharCode(96);

let passed = 0;
const failures = [];
function ok(cond, label) {
	if (cond) passed += 1;
	else failures.push(label);
}
/** Deep comparison through JSON, so a failure prints both sides. */
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	ok(a === b, label + ' — expected ' + b + ', got ' + a);
}

const sw = await load('./lib/switch.js');
const routes = await load('./lib/routes.js');
const build = await load('./lib/build.js');
const settingsMod = await load('./lib/settings.js');
const gateSettings = await load('./lib/gate-settings.js');
const stateMod = await load('./lib/state.js');
const cursorPlan = await load('./lib/cursor-plan.js');
const delegationGate = await load('./lib/delegation-gate.js');
const projection = await load('./lib/projection.js');
// Since 0.2.3 the commit writes a host PLUGIN RECORD through
// `appendPluginRecord`. That helper publishes on a module-private Session method,
// so a fake session object cannot receive it: the seam is the same call. What the
// shipped writer actually stamps (`plugin:` type + `ignorable: true`) is proven
// against the real host module in self-check-fold.mjs.
projection.setModeEventAppend((session, type, data) => session.append(type, data));
const multiPrompt = await load('./lib/multi-prompt.js');
const planfile = await load('./lib/planfile.js');

// ---------------------------------------------------------------------------
// A request/response pair the real handlers accept. readJsonBody() iterates the
// request, so the iterator is the part that must be honest: raw sends bytes
// that do not parse, which is the only way to reach the malformed-JSON branch.
// ---------------------------------------------------------------------------
function makeReq(options) {
	const o = options || {};
	const headers = Object.assign({ host: '127.0.0.1:4000' }, o.headers || {});
	return {
		method: o.method === undefined ? 'POST' : o.method,
		headers,
		socket: { remoteAddress: o.remoteAddress === undefined ? '127.0.0.1' : o.remoteAddress },
		// The plan-state read is the one GET route; it parses this.
		url: o.url,
		async *[Symbol.asyncIterator]() {
			yield Buffer.from(o.raw !== undefined ? o.raw : JSON.stringify(o.body === undefined ? {} : o.body));
		}
	};
}
async function callRoute(route, options) {
	const captured = { status: 0, body: undefined };
	const res = {
		writeHead(status) { captured.status = status; },
		end(text) { captured.body = JSON.parse(text); }
	};
	await route.handler(makeReq(options), res);
	return captured;
}

const ROUTES_PREFIX = routes.ROUTES_PREFIX;
const blankState = () => stateMod.createState();
const quietHost = () => ({ logger: { warn() {} } });
const flush = () => new Promise((done) => setTimeout(done, 25));
const inboxOf = (messages) => ({
	nextStep: messages,
	remove(id) {
		const at = this.nextStep.findIndex((message) => message.id === id);
		if (at < 0) return false;
		this.nextStep.splice(at, 1);
		return true;
	}
});
const clickOf = (summary, over) => ({ role: 'user', source: Object.assign({ kind: 'cursor-plan', form: 'notice', summary }, over || {}) });
const noticeOf = (kind, summary, id, over) => ({ id, source: Object.assign({ kind, form: 'notice', summary }, over || {}) });

// ===========================================================================
// 1. The nine routes (blueprint 4.4)
// ===========================================================================
const EXPECTED_SUFFIX = [
	'/build',
	'/plan-state',
	'/settings/describe',
	'/settings/mutate',
	'/settings/status',
	'/switch/stage',
	'/switch/clear',
	'/switch/self-test',
	'/switch/vocabulary'
];
const mountContext = {
	agents: undefined,
	settings: undefined,
	gate: () => ({}),
	verdicts: { last: null },
	credential: async () => ({ ref: '', configured: false })
};
const allRoutes = routes.makeRoutes(mountContext, blankState());
const allPaths = allRoutes.map((route) => route.path);

eq(ROUTES_PREFIX, '/api/dsh-cursor-modes', 'one prefix, named after the merged plugin');
eq(allRoutes.length, 9, 'makeRoutes mounts exactly nine routes');
ok(allRoutes.every((route) => route.kind === 'exact'), 'every route is kind exact (no prefix or param routes)');
ok(allRoutes.every((route) => typeof route.handler === 'function'), 'every route carries a handler');
eq(allPaths, EXPECTED_SUFFIX.map((suffix) => ROUTES_PREFIX + suffix), 'the nine paths, in mounted order');
eq(new Set(allPaths).size, 9, 'no two routes share a path');
ok(allPaths.every((path) => path.startsWith(ROUTES_PREFIX + '/')), 'every path sits under the one prefix');
for (const suffix of EXPECTED_SUFFIX) {
	ok(allPaths.includes(ROUTES_PREFIX + suffix), 'route is mounted: ' + suffix);
}
// The retired prefixes are gone (blueprint 4.4): a route still answering on one
// of them is a path that can never 404, and a second assertion table to keep.
for (const retired of ['/api/dsh-cursor-plan-build', '/api/dsh-cursor-plan-settings', '/api/dsh-mode-switch']) {
	ok(!allPaths.some((path) => path.startsWith(retired)), 'no route survives under the retired prefix ' + retired);
}
// The sub-factories, so a family cannot shrink without this failing.
eq(build.makeBuildRoutes(undefined, blankState()).map((route) => route.path).join(','),
	[build.BUILD_PATH, build.PLAN_STATE_PATH].join(','),
	'the build family is the build POST plus the plan-state GET');
eq(gateSettings.makeGateRoutes(undefined, { gate: () => ({}), verdicts: { last: null }, credential: async () => ({ ref: '', configured: false }) }).length, 3, 'the settings family is three routes');
eq(routes.makeSwitchRoutes(mountContext, blankState()).length, 4, 'the switch family is four routes');
eq(routes.makePendingRoutes(blankState()).length, 2, 'stage + clear are the pending pair');
eq(build.BUILD_PATH, ROUTES_PREFIX + '/build', 'build.js names its own path under the shared prefix');
eq(sw.BRIDGE_PREFIX, ROUTES_PREFIX + '/switch', 'switch.js owns the pending bridge prefix');
eq(routes.BRIDGE_PREFIX, sw.BRIDGE_PREFIX, 'routes.js re-exports that one binding, not a second copy');
eq(gateSettings.GATE_BRIDGE_PREFIX, ROUTES_PREFIX + '/settings', 'gate-settings.js owns the settings bridge prefix');
eq(routes.makeSelfTestRoute(mountContext, blankState()).path, ROUTES_PREFIX + '/switch/self-test', 'the self-test route is a switch route');
eq(routes.vocabularyRoute(blankState()).path, ROUTES_PREFIX + '/switch/vocabulary', 'the diagnostics route is a switch route');

// ===========================================================================
// 2. Every refusal branch, driven through the real handler
// ===========================================================================
// The settings family answers {error: '...'} — it predates the {ok, code} shape
// the rest of the bridge uses. Asserting the difference keeps a future "unify
// the refusal shape" edit from silently splitting the two client call sites.
const settingsPaths = [ROUTES_PREFIX + '/settings/describe', ROUTES_PREFIX + '/settings/mutate', ROUTES_PREFIX + '/settings/status'];
const plainPaths = allPaths.filter((path) => !settingsPaths.includes(path));

for (const route of allRoutes) {
	const remote = await callRoute(route, { remoteAddress: '10.1.2.3', body: { sessionId: 's-1' } });
	ok(remote.status === 403, '403 for a non-loopback caller: ' + route.path);
	if (settingsPaths.includes(route.path)) {
		eq(remote.body, { error: 'loopback requests only' }, 'the settings family refuses with an error string: ' + route.path);
	} else {
		eq(remote.body, { ok: false, code: 'loopback-only', message: 'loopback requests only' }, 'the bridge refuses with a code: ' + route.path);
	}
}
const PLAN_STATE = ROUTES_PREFIX + '/plan-state';
for (const route of allRoutes) {
	// /plan-state is the one GET route: its method refusal is asserted inside the
	// plan-state block below, where "POST is wrong" is the honest statement.
	if (route.path === PLAN_STATE) continue;
	const wrong = await callRoute(route, { method: 'GET', body: { sessionId: 's-1' } });
	ok(wrong.status === 405, '405 for a non-POST method: ' + route.path);
	if (settingsPaths.includes(route.path)) {
		eq(wrong.body, { error: 'method not allowed: GET' }, 'settings family 405 wording: ' + route.path);
	} else {
		eq(wrong.body, { ok: false, code: 'method-not-allowed', message: 'method not allowed: GET' }, 'bridge 405 wording: ' + route.path);
	}
}
eq(plainPaths.length, 6, 'six routes refuse through the shared guard');

const pendingPair = routes.makePendingRoutes(blankState());
const stageRoute = pendingPair[0];
const clearRoute = pendingPair[1];
const selfTestNoAgents = routes.makeSelfTestRoute(mountContext, blankState());

// malformed bodies, per route family
eq((await callRoute(stageRoute, { raw: '{' })).body, { ok: false, code: 'malformed-request', message: 'a JSON object body is required' }, 'an unparseable body is malformed-request');
eq((await callRoute(stageRoute, { body: [] })).body, { ok: false, code: 'malformed-request', message: 'a JSON object body is required' }, 'an array body is malformed-request');
eq((await callRoute(stageRoute, { body: { target: 'plan' } })).body, { ok: false, code: 'malformed-request', message: 'sessionId must be a non-empty string' }, 'a missing sessionId has its own message');
eq((await callRoute(stageRoute, { body: { sessionId: 42, target: 'plan' } })).body.message, 'sessionId must be a non-empty string', 'a non-string sessionId is refused');
eq((await callRoute(stageRoute, { body: { sessionId: '' } })).body.message, 'sessionId must be a non-empty string', 'an empty sessionId is refused');
eq((await callRoute(clearRoute, { body: {} })).status, 400, 'clear refuses a body with no sessionId');
eq((await callRoute(selfTestNoAgents, { raw: 'nope' })).body.code, 'malformed-request', 'self-test refuses an unparseable body');
eq((await callRoute(selfTestNoAgents, { body: [] })).body.message, 'a JSON object body is required', 'self-test refuses an array body');

// unknown mode: HTTP 200 with ok:false — a staged target is a value, not a
// transport error, and the client reads answer.ok rather than the status.
const unknownTarget = await callRoute(stageRoute, { body: { sessionId: 's-off', target: 'off' } });
eq(unknownTarget.status, 200, 'an unknown target answers 200, not 400');
eq(unknownTarget.body, { ok: false, code: 'unknown-mode', message: 'target must be one of default, plan, multi' }, 'the unknown-mode refusal lists the live value domain');
eq((await callRoute(stageRoute, { body: { sessionId: 's-null', target: null } })).body.code, 'unknown-mode', 'a null target is unknown-mode');
eq((await callRoute(stageRoute, { body: { sessionId: 's-42', target: 42 } })).body.code, 'unknown-mode', 'a numeric target is unknown-mode');
ok(!blankState().pending.has('s-off'), 'a refused stage writes nothing');

// self-test without an agents service: 503, because "no harness" is not the
// caller's fault and 400 would read as "fix your body".
const noAgents = await callRoute(selfTestNoAgents, { body: {} });
eq(noAgents.status, 503, 'self-test without an agents service answers 503');
eq(noAgents.body, { ok: false, code: 'no-agents', message: 'the agents service is not reachable from this context' }, 'the 503 names the missing service');
eq((await callRoute(routes.makeSelfTestRoute({ agents: {} }, blankState()), { body: {} })).body.code, 'no-agents', 'an agents object without create() is also no-agents');

// build: no live agent is 409, so the card never believes a build started.
const liveMap = new Map();
const buildRoute = build.makeBuildRoutes({ get: (id) => liveMap.get(id) }, blankState())[0];
const deadBuild = await callRoute(buildRoute, { body: { sessionId: 'dead', choice: 'multi' } });
eq(deadBuild.status, 409, 'the no-live-agent refusal is 409');
eq(deadBuild.body, { ok: false, code: 'session-not-live', message: 'no live agent for session dead' }, '409 names the session with no live agent');
eq((await callRoute(buildRoute, { body: { sessionId: 's', choice: 'sideways' } })).body, { ok: false, code: 'unknown-choice', message: 'choice must be one of multi, default' }, 'an unknown choice lists the domain');
eq((await callRoute(buildRoute, { body: { sessionId: 's', choice: 'multi' } })).body.code, 'session-not-live', 'the choice is validated before the agent lookup');
eq((await callRoute(buildRoute, { body: { choice: 'multi' } })).body.message, 'sessionId must be a non-empty string', 'build refuses a missing sessionId');
eq((await callRoute(buildRoute, { raw: '}' })).body.message, 'a JSON object body is required', 'build refuses an unparseable body');
const steerBoom = { id: 'boom', steer() { throw new Error('inbox is closed'); } };
liveMap.set('boom', steerBoom);
const failedBuild = await callRoute(buildRoute, { body: { sessionId: 'boom', choice: 'default' } });
eq(failedBuild.status, 500, 'a throwing steer is a 500');
eq(failedBuild.body, { ok: false, code: 'steer-failed', message: 'inbox is closed' }, 'the steer failure names its cause');

// --- the plan-state read: the answer the card draws its action row from -----
// The card reads the plan file's dispatch stamp before it shows anything, so an
// already-built plan comes back as Dispatched after a reload, in another tab, in
// another browser. DSH_HOME is redirected to a temp home for this block: the
// fixture must never land in the profile's own plans/.
{
	const home = mkdtempSync(join(tmpdir(), 'dsh-plan-state-'));
	const realHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const stateRoute = allRoutes.find((route) => route.path === PLAN_STATE);
		ok(stateRoute !== undefined, 'the plan-state read is mounted on the route table');
		eq(stateRoute?.kind, 'exact', 'the plan-state read is one exact path');
		const read = (query) => callRoute(stateRoute, { method: 'GET', url: PLAN_STATE + '?' + query, body: {} });
		const planFile = join(home, 'plans', 'demo_ab12cd34.plan.md');
		mkdirSync(join(home, 'plans'), { recursive: true });
		writeFileSync(planFile, '---\nname: demo\nisProject: false\n---\n\n# Demo\n', 'utf8');
		const fresh = await read('path=' + encodeURIComponent(planFile));
		eq(fresh.status, 200, 'a plan file under plans/ answers 200');
		eq(fresh.body, { ok: true, value: { exists: true, dispatched: false, todos: [] } },
			'a plan written before the stamp existed is NOT dispatched: the buttons stay');
		planfile.markPlanDispatched(planFile, 'multi', '2026-10-24T00:00:00.000Z');
		eq((await read('path=' + encodeURIComponent(planFile))).body,
			{ ok: true, value: { exists: true, dispatched: true, choice: 'multi', at: '2026-10-24T00:00:00.000Z', todos: [] } },
			'the stamp survives a reload, which is why it lives in the file');
		// The checklist rides the same answer, straight from the frontmatter: the FILE is the
		// single source of truth for the card, so editing it is enough (no second plan file).
		const todoFile = join(home, 'plans', 'checklist_cd34ef56.plan.md');
		const todoText = (first, second) => '---\nname: demo\ntodos:\n  - id: a\n    content: first\n    status: ' + first
			+ (second === undefined ? '' : '\n  - id: b\n    content: second\n    status: ' + second)
			+ '\nisProject: false\n---\n\n# Demo\n';
		writeFileSync(todoFile, todoText('pending'), 'utf8');
		eq((await read('path=' + encodeURIComponent(todoFile))).body.value.todos,
			[{ id: 'a', content: 'first', status: 'pending' }],
			'the frontmatter checklist comes back with the stamp');
		writeFileSync(todoFile, todoText('completed', 'in_progress'), 'utf8');
		eq((await read('path=' + encodeURIComponent(todoFile))).body.value.todos,
			[{ id: 'a', content: 'first', status: 'completed' }, { id: 'b', content: 'second', status: 'in_progress' }],
			'editing the frontmatter is what changes the card: the file is the one source of truth');
		const missing = await read('path=' + encodeURIComponent(join(home, 'plans', 'gone_00000000.plan.md')));
		eq(missing.body, { ok: true, value: { exists: false, dispatched: false } },
			'a vanished plan file is not an error: the card keeps its buttons');
		eq((await read('path=' + encodeURIComponent(join(home, 'notes.plan.md')))).status, 400,
			'a .plan.md outside plans/ is refused');
		eq((await read('path=' + encodeURIComponent(join(home, 'notes.plan.md')))).body.code, 'invalid-plan-path',
			'and says which path rule it broke');
		eq((await read('path=' + encodeURIComponent(join(home, 'plans', '..', 'escape.plan.md')))).status, 400,
			'a traversal out of plans/ is refused');
		eq((await read('')).status, 400, 'a missing path is refused instead of read');
		eq((await callRoute(stateRoute, { method: 'POST', body: {} })).status, 405, 'the plan-state read is GET only');
	} finally {
		if (realHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = realHome;
		rmSync(home, { recursive: true, force: true });
	}
}

// ===========================================================================
// 3. The mode alphabet, and the command path that no longer exists
// ===========================================================================
eq(sw.MODE_IDS, ['default', 'plan', 'multi'], 'one alphabet, the projection one');
eq(sw.SWITCHABLE, ['plan', 'multi'], 'the switchable modes are the two non-default ones');
// 2026-10-23: the two mode commands were deleted outright. Switching goes
// through the bridge and agent/pre-step only, so a surviving export here would
// be a second way in — exactly what the removal existed to prevent.
for (const gone of ['netChange', 'offCommand', 'composeNotice', 'submitCommands', 'applyNetChange', 'wireSwitch', 'switchNoticeId', 'isDecisionPoint', 'hookStats', 'MULTI_COMMAND', 'MODES', 'capsOf']) {
	ok(sw[gone] === undefined, 'the command path is gone: ' + gone);
}
ok(sw.BRIDGE_PREFIX === '/api/dsh-cursor-modes/switch', 'the one way in is the switch bridge');
eq(sw.switchSummary('multi'), 'dsh-cursor-modes: switched to multi mode', 'the one GUI line names the mode it switched to');
eq(sw.switchSummary('default'), 'dsh-cursor-modes: switched to default mode', 'and carries no budget line: there is no budget any more');

// --- asModeId: the nine inputs the blueprint names, plus the edges ----------
eq(sw.asModeId('default'), 'default', 'asModeId passes default through');
eq(sw.asModeId('plan'), 'plan', 'asModeId passes plan through');
eq(sw.asModeId('multi'), 'multi', 'asModeId passes multi through');
eq(sw.asModeId('cursorPlan'), 'plan', 'asModeId maps the retired cursorPlan to plan');
eq(sw.asModeId('cursorMulti'), 'multi', 'asModeId maps the retired cursorMulti to multi');
eq(sw.asModeId('off'), undefined, 'asModeId refuses off');
eq(sw.asModeId('bogus'), undefined, 'asModeId refuses an unknown word');
eq(sw.asModeId(null), undefined, 'asModeId refuses null');
eq(sw.asModeId(42), undefined, 'asModeId refuses a number');
eq(sw.asModeId(''), undefined, 'asModeId refuses the empty string');
eq(sw.asModeId('Plan'), undefined, 'asModeId is case exact — no folding');
eq(sw.asModeId(' plan'), undefined, 'asModeId does not trim');
eq(sw.asModeId(undefined), undefined, 'asModeId refuses undefined');
eq(sw.asModeId(['plan']), undefined, 'asModeId refuses an array');
ok(sw.asModeId.length === 1, 'asModeId takes exactly one argument');

// ===========================================================================
// 4. stage -> build -> clear: the pending chain, on the real handlers
// ===========================================================================
const chainState = blankState();
const chainRoutes = routes.makePendingRoutes(chainState);
const chainMessages = [];
const chainAgent = { id: 'chain', steer(message) { chainMessages.push(message); } };
const chainBuildRoute = build.makeBuildRoutes({ get: (id) => (id === 'chain' ? chainAgent : undefined) }, blankState())[0];

const stagedOk = await callRoute(chainRoutes[0], { body: { sessionId: 'chain', target: 'plan' } });
eq(stagedOk.status, 200, 'a legal stage answers 200');
eq(stagedOk.body, { ok: true, value: { sessionId: 'chain', target: 'plan' } }, 'a legal stage echoes the merged target');
const stagedEntry = chainState.pending.get('chain');
eq(stagedEntry.mode, 'plan', 'the pending entry carries the resolved mode');
eq(stagedEntry.origin, 'bridge', 'a route stage is stamped origin bridge');
ok(typeof stagedEntry.at === 'number' && stagedEntry.at > 0, 'the pending entry carries a timestamp');
eq(chainState.pending.size, 1, 'one staged session is one entry');
eq((await callRoute(chainRoutes[0], { body: { sessionId: 'chain', target: 'cursorMulti' } })).body.value.target, 'multi', 'a retired id stages the merged one and the reply says so');
eq(chainState.pending.get('chain').mode, 'multi', 'the pending entry holds the merged id, not the posted one');

const builtOk = await callRoute(chainBuildRoute, { body: { sessionId: 'chain', choice: 'multi' } });
eq(builtOk.status, 200, 'a live agent accepts the build');
eq(builtOk.body, { ok: true, value: { sessionId: 'chain', choice: 'multi', mode: 'multi', dispatched: false } }, 'the build reply names the choice and the mode, and reports that no plan file was stamped (none was sent)');
eq(chainMessages.length, 1, 'a build steers exactly one message');
eq(chainMessages[0].role, 'user', 'the steered message is a user message');
eq(chainMessages[0].source.summary, 'The user clicked Build in Multi.', 'the steered message carries the bare build summary');
ok(sw.isBuildClick(chainMessages[0]) === true, 'the message switch.js sees IS a build click');
ok(chainState.pending.has('chain'), 'the build route does NOT consume the staged mode — the inbox hook does');
eq(chainMessages[0].content[0].text, build.buildText('multi'), 'the steered text is the host build text, verbatim');

const clearedOk = await callRoute(chainRoutes[1], { body: { sessionId: 'chain' } });
eq(clearedOk.body, { ok: true, value: { sessionId: 'chain', target: null } }, 'clear answers with target null');
ok(!chainState.pending.has('chain'), 'clear empties the pending entry');
eq(chainState.pending.size, 0, 'clear leaves the map empty');
eq((await callRoute(chainRoutes[1], { body: { sessionId: 'chain' } })).status, 200, 'clearing an absent entry is still 200');
ok(!chainState.pending.has('chain'), 'a second clear is still a no-op');

// ===========================================================================
// 5. The pure halves (absorbed from the retired mode-switch self-check)
// ===========================================================================
// --- isBuildClick ---------------------------------------------------------
ok(sw.isBuildClick(clickOf('The user clicked Build in Multi.')) === true, 'a Multi build summary is a build click');
ok(sw.isBuildClick(clickOf('The user clicked Build in Default.')) === true, 'a Default build summary is a build click');
ok(sw.isBuildClick(clickOf('The user clicked "Build in Multi".')) === false, 'the quoted text is the message body, not the summary');
ok(sw.isBuildClick(clickOf('The user clicked Build in Multi.', { kind: 'user' })) === false, 'the kind must be cursor-plan, not just the wording');
ok(sw.isBuildClick(clickOf('The user clicked Build in Multi.', { form: 'summary' })) === false, 'the form must be notice');
ok(sw.isBuildClick(clickOf('The user clicked Build in Sideways.')) === false, 'an unknown button word is not a build click');
ok(sw.isBuildClick({ role: 'user' }) === false, 'a message with no source is not a build click');
ok(sw.isBuildClick(undefined) === false, 'undefined is not a build click');
ok(sw.isBuildClick(clickOf('The user switched this session to plan mode.')) === false, 'a switch notice is not a build click');

// --- compositeNoticeText: the six sentences, one shape each ---------------
eq(sw.compositeNoticeText('default', 'plan'), 'The user switched this session to plan mode.', 'entering plan from default names only the target');
eq(sw.compositeNoticeText('default', 'multi'), 'The user switched this session to multitask mode.', 'entering multitask is the same one sentence: the budget line is gone (2026-11-16)');
eq(sw.compositeNoticeText('plan', 'default'), 'The user switched this session back to the default mode.', 'returning to default is the back-to-default sentence');
eq(sw.compositeNoticeText('multi', 'default'), 'The user switched this session back to the default mode.', 'returning to default from multitask is the same sentence');
eq(sw.compositeNoticeText('plan', 'multi'), 'The user switched this session from plan mode to multitask mode.', 'a cross-mode switch names the origin, because the leave notice was withdrawn');
eq(sw.compositeNoticeText('multi', 'plan'), 'The user switched this session from multitask mode to plan mode.', 'the reverse cross-mode switch names its own origin');
eq(sw.compositeNoticeText('plan', 'plan'), undefined, 'a no-op switch writes nothing');
eq(sw.compositeNoticeText('default', 'default'), undefined, 'a default-to-default switch writes nothing');
let compositeThrow = null;
try { sw.compositeNoticeText('default', 'nope'); } catch (reason) { compositeThrow = reason.message; }
eq(compositeThrow, 'unknown mode: nope', 'an unknown target throws instead of writing a wrong sentence');
// The nine-pair loop: no budget line anywhere (the quota is gone), no origin
// clause without a real origin, and every non-identity pair produces exactly one
// sentence.
for (const from of sw.MODE_IDS) {
	for (const to of sw.MODE_IDS) {
		if (from === to) continue;
		const text = sw.compositeNoticeText(from, to);
		ok(typeof text === 'string' && text.startsWith('The user switched this session'), from + ' -> ' + to + ' writes the one switch sentence');
		ok(!/budget|quota|request_more_edits/.test(text), from + ' -> ' + to + ' carries no quota wording of any kind');
		ok(text.includes(' from ') === (from !== 'default' && to !== 'default'), from + ' -> ' + to + ' names the origin only between two modes');
	}
}

// --- commitPending: S1 (only the user's own message lands it) + one notice ---
// The whole replacement for the two commands: the selection lands at the step
// that claims the user's own prompt, and that same step carries the one
// sentence the model reads. Everything else — a timer wake, a bare click, a
// step with nothing — leaves the selection pending.
{
	const makeHost = (mode) => ({
		logger: { warn() {} },
		tools: { get: (name) => (name === 'run_code' ? {} : undefined) },
		sessionProjections: { stateOf: () => ({ mode }) }
	});
	const appends = [];
	const agent = {
		session: { id: 's-cp', append: (type, data) => appends.push({ type, data }) },
		inbox: inboxOf([])
	};
	const state = stateMod.createState();
	const host = makeHost('default');
	const userMessage = { role: 'user', source: { kind: 'user' } };
	const commit = (decision, mode = 'default', requireUserMessage = true) =>
		stateMod.commitPending(makeHost(mode), state, agent, decision, undefined, { requireUserMessage });

	state.pending.set('s-cp', { mode: 'plan', at: 1, origin: 'bridge' });
	const noUser = commit({ kind: 'allow', messages: [] });
	eq(noUser.messages, [], 'S1: a step that delivered no user message commits nothing');
	eq(appends, [], 'and appends nothing');
	ok(state.pending.has('s-cp'), 'the selection stays pending');

	const timer = commit({ kind: 'allow', messages: [{ role: 'user', source: { kind: 'goal' } }] });
	eq(timer.messages.length, 1, 'S1: a goal/schedule wake is not the user speaking');
	ok(state.pending.has('s-cp'), 'so it leaves the selection alone too');

	const committed = commit({ kind: 'allow', messages: [userMessage] });
	eq(appends, [{ type: projection.MODE_RECORD, data: { mode: 'plan' } }], 'the user message commits the selection exactly once, as the `plugin:` record');
	eq(committed.messages.length, 2, 'and the step gains exactly one message: the switch notice');
	eq(committed.messages[1].source.kind, 'dsh-cursor-modes', 'the notice wears this plugin own kind');
	eq(committed.messages[1].source.form, 'notice', 'and form notice');
	eq(committed.messages[1].source.summary, 'dsh-cursor-modes: switched to plan mode', 'the summary is the one line the GUI can show');
	eq(committed.messages[1].content[0].text, 'The user switched this session to plan mode.', 'the body is the sentence the model reads');
	eq(state.lastCommit.to, 'plan', 'the diagnostics record names the mode it committed');

	// Identity is zero action: a selection equal to the log appends nothing.
	state.pending.set('s-cp', { mode: 'plan', at: 2, origin: 'bridge' });
	const same = commit({ kind: 'allow', messages: [userMessage] }, 'plan');
	eq(same.messages.length, 1, 'a selection equal to the logged mode is a no-op');
	eq(appends.length, 1, 'and appends nothing more');

	// A rejected step or an aborted signal keeps the selection (invariant I1).
	state.pending.set('s-cp', { mode: 'multi', at: 3, origin: 'bridge' });
	eq(commit({ kind: 'reject' }).kind, 'reject', 'a rejected step stays rejected');
	ok(state.pending.has('s-cp'), 'and keeps the selection for the next step');
	const aborted = new AbortController();
	aborted.abort();
	eq(stateMod.commitPending(host, state, agent, { kind: 'allow', messages: [userMessage] }, aborted.signal, { requireUserMessage: true }).messages.length, 1, 'an aborted step commits nothing');
	ok(state.pending.has('s-cp'), 'and keeps the selection too');

	// Entering multitask is one sentence, exactly like entering plan: the per-stretch
	// budget line that used to ride it was removed with the quota mechanism.
	state.pending.set('s-cp', { mode: 'multi', at: 4, origin: 'bridge' });
	const intoMulti = commit({ kind: 'allow', messages: [userMessage] });
	eq(intoMulti.messages[1].content[0].text, 'The user switched this session to multitask mode.', 'entering multitask appends nothing beyond the one switch sentence');

	// A Build click is the user's own decision, and its own message is the line.
	state.pending.set('s-cp', { mode: 'default', at: 5, origin: 'bridge' });
	const built = commit({ kind: 'allow', messages: [clickOf('The user clicked Build in Multi.')] }, 'multi');
	eq(built.messages.length, 1, 'a Build click commits without a second sentence');
	eq(state.lastCommit.to, 'default', 'and still records the commit');
}

// --- selfTestSteps -------------------------------------------------------
const DEFAULT_STEPS = [{ target: 'plan', text: 'hi', waitMs: 1500 }, { target: 'multi', text: 'ok', waitMs: 1500 }];
eq(sw.selfTestSteps(undefined), DEFAULT_STEPS, 'the default self-test enters plan, then multi');
eq(sw.selfTestSteps([]), DEFAULT_STEPS, 'an empty list falls back to the default steps');
eq(sw.selfTestSteps('nope'), DEFAULT_STEPS, 'a non-array falls back to the default steps');
eq(sw.selfTestSteps([{ target: 'cursorPlan' }]), [{ target: 'plan', text: 'hi', waitMs: 1500 }], 'the retired target id is mapped in a self-test step too');
eq(sw.selfTestSteps([{ target: 'off' }])[0].target, 'default', 'an unknown step target degrades to default rather than throwing');
eq(sw.selfTestSteps([{ target: 'plan', text: '' }])[0].text, 'hi', 'an empty text falls back to hi');
eq(sw.selfTestSteps([{ target: 'plan', text: 42 }])[0].text, 'hi', 'a non-string text falls back to hi');
eq(sw.selfTestSteps([{ target: 'plan', text: 'go' }])[0].text, 'go', 'a real text is kept');
eq(sw.selfTestSteps([{ target: 'plan', waitMs: 0 }])[0].waitMs, 0, 'a zero wait is legal');
eq(sw.selfTestSteps([{ target: 'plan', waitMs: 20000 }])[0].waitMs, 20000, 'the upper bound itself is legal');
eq(sw.selfTestSteps([{ target: 'plan', waitMs: 20001 }])[0].waitMs, 1500, 'one past the bound falls back');
eq(sw.selfTestSteps([{ target: 'plan', waitMs: -1 }])[0].waitMs, 1500, 'a negative wait falls back');
eq(sw.selfTestSteps([{ target: 'plan', waitMs: 'x' }])[0].waitMs, 1500, 'a non-numeric wait falls back');
eq(sw.selfTestSteps([{}, {}, {}, {}, {}]).length, 4, 'the step list is capped at four');
eq(sw.selfTestSteps([null])[0].target, 'default', 'a null step entry degrades to default');

// --- the two halves agree on the one build summary -----------------------
eq(build.BUILD_TARGETS, { multi: 'multi', default: 'default' }, 'the host build targets are the merged ids');
eq(Object.keys(build.BUILD_TARGETS).sort(), ['default', 'multi'], 'the build choices are default and multi, nothing else');
eq(build.BUILD_LABELS, { multi: 'Build in Multi', default: 'Build in Default' }, 'the two button labels');
ok(sw.isBuildClick(build.buildMessage('multi')) === true, 'the message the host steers IS the message the hook recognises');
ok(sw.isBuildClick(build.buildMessage('default')) === true, 'both build messages are recognised');
eq(build.buildMessage('multi').source.summary, 'The user clicked Build in Multi.', 'the summary is bare — only the body quotes the label');
const instruction = 'Implement the plan as specified. The plan file is in your context history; the plan body is NOT. Read it before you start, do NOT edit the plan file itself, and do NOT create a new plan — the plan file stays for reference.';
const handoff = ' When you delegate, give each worker the plan file path, the part it owns, and its own slice of the checklist as the subagent `todos` argument — and have it read the plan file itself; never paste the plan body into a worker prompt. Keep the checklist in the workers\' hands: do not write your own todo list in this conversation — the main thread assigns work and reports back.';
eq(build.buildText('multi'), 'The user clicked "Build in Multi". ' + instruction + handoff, 'the multi message, verbatim');
eq(build.buildText('default'), 'The user clicked "Build in Default". ' + instruction, 'the default message, verbatim, without the handoff');
eq(build.buildText('default').includes(handoff), false, 'only Build in Multi carries the delegation handoff');
ok(build.buildText('multi').includes('its own slice of the checklist as the subagent `todos` argument'), 'multi hands each worker its checklist slice through the todos argument');
ok(build.buildText('multi').includes('do not write your own todo list in this conversation'), 'multi keeps the checklist in the workers\' hands');
eq(build.buildText('default').includes('todo list'), false, 'default never mentions a todo list');
ok(build.buildText('multi').includes('do NOT edit the plan file itself'), 'the build instruction still forbids editing the plan file');

// ===========================================================================
// 6. The settings seam: namespace, prefix, describe/mutate/status
// ===========================================================================
eq(settingsMod.GATE_SETTINGS_NS, 'cursor-modes', 'the settings namespace is the merged plugin name');
eq(gateSettings.GATE_SETTINGS_NS, 'cursor-modes', 'both modules name the same namespace literal');
ok(settingsMod.GATE_SETTINGS_NS !== 'cursor-plan', 'the retired cursor-plan namespace is gone (blueprint 9 R7)');

const readGate = () => Object.assign({}, cursorPlan.GATE_DEFAULTS, { timeoutMs: 4000 });
const gateHooks = { gate: readGate, verdicts: { last: null }, credential: async () => ({ ref: 'OPENROUTER_API_KEY', configured: false }) };
const writtenCalls = [];
const fakeSettings = {
	describe: () => [{ ns: 'cursor-modes', value: { gate: { enabled: false } } }],
	update: async (ns, body) => { writtenCalls.push([ns, body]); }
};
const gateRoutes = gateSettings.makeGateRoutes(fakeSettings, gateHooks);
eq(gateRoutes.map((route) => route.path), [ROUTES_PREFIX + '/settings/describe', ROUTES_PREFIX + '/settings/mutate', ROUTES_PREFIX + '/settings/status'], 'the three settings paths, in order');
ok(gateRoutes.every((route) => route.kind === 'exact'), 'all three settings routes are exact');
const describeRoute = gateRoutes[0];
const mutateRoute = gateRoutes[1];
const statusRoute = gateRoutes[2];

const describedOk = await callRoute(describeRoute, { body: {} });
eq(describedOk.status, 200, '/describe answers 200');
eq(describedOk.body.ok, true, '/describe is ok when the namespace is listed');
eq(describedOk.body.value.ns, 'cursor-modes', '/describe names the merged namespace');
eq(describedOk.body.value.values.timeoutMs, 4000, '/describe serves the live values, not the defaults');
eq(Object.keys(describedOk.body.value.defaults), ['enabled', 'backend', 'model', 'baseUrl', 'timeoutMs', 'allowConfidence', 'workReject', 'apiKeyRef'], '/describe carries every deployment default except the key');
eq(Object.keys(describedOk.body.value.values), ['enabled', 'backend', 'model', 'baseUrl', 'timeoutMs', 'allowConfidence', 'workReject', 'apiKeyRef'], '/describe serves every stored gate field except the key');
eq(describedOk.body.value.apiKeyConfigured, false, '/describe answers the key as one boolean, and nothing is stored here');
ok(!JSON.stringify(describedOk.body).includes('"apiKey":'), '/describe carries no apiKey member at all, in values or in defaults');
eq(describedOk.body.value.credential, { ref: 'OPENROUTER_API_KEY', configured: false }, '/describe reports the credential as a boolean, never a secret');

const mutatedOk = await callRoute(mutateRoute, { body: { patch: { timeoutMs: 9000 } } });
eq(mutatedOk.status, 200, '/mutate answers 200');
eq(mutatedOk.body.ok, true, '/mutate is ok for a legal patch');
eq(writtenCalls, [['cursor-modes', { gate: { timeoutMs: 9000 } }]], 'the flat card patch is nested under gate for the config-schema seam, and written to the merged namespace');
eq(mutatedOk.body.value.timeoutMs, 4000, '/mutate answers with the effective values read back, not the patch');

await callRoute(mutateRoute, { body: { patch: {} } });
eq(writtenCalls.length, 1, 'an empty patch writes nothing');
eq((await callRoute(mutateRoute, { body: { patch: { enabled: 'yes' } } })).body, { ok: false, code: 'settings-rejected', message: 'gate ' + BT + 'enabled' + BT + ' must be a boolean' }, 'a wrong-typed field is refused with the gate clause');
eq((await callRoute(mutateRoute, { body: { patch: { timeoutMs: 0 } } })).body.message, 'gate ' + BT + 'timeoutMs' + BT + ' must be a positive integer', 'a zero timeout is refused');
eq((await callRoute(mutateRoute, { body: { patch: { allowConfidence: 5 } } })).body.message, 'gate ' + BT + 'allowConfidence' + BT + ' must be a number in [0, 1]', 'an out-of-range confidence is refused');
eq((await callRoute(mutateRoute, { body: { patch: { sideways: 1 } } })).body.message, 'gate has unknown key(s) sideways', 'an unknown field is refused, so a typo cannot be silently dropped');
eq((await callRoute(mutateRoute, { body: { patch: undefined } })).body.message, 'gate must be an object', 'a missing patch is refused');
eq((await callRoute(mutateRoute, { raw: 'null' })).body, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request (patch is required)' }, 'a null body is refused as malformed');
eq((await callRoute(mutateRoute, { raw: '{' })).body, { ok: false, code: 'settings-rejected', message: 'malformed JSON body' }, 'an unparseable body is refused before the patch is read');
eq((await callRoute(mutateRoute, { raw: '[]' })).body.code, 'settings-rejected', 'an array body is refused');
eq(writtenCalls.length, 1, 'no refused mutate ever reached settings.update');

// The JEV key: written as a plain string, answered as one boolean, and never
// echoed back — the card's box is rewritten from empty after every write.
const keyedHooks = Object.assign({}, gateHooks, { gate: () => Object.assign({}, readGate(), { apiKey: 'sk-test-123' }) });
const keyedDescribe = await callRoute(gateSettings.makeGateRoutes(fakeSettings, keyedHooks)[0], { body: {} });
eq(keyedDescribe.body.value.apiKeyConfigured, true, 'a stored key reads as 已保存');
eq(keyedDescribe.body.value.values.apiKey, undefined, 'and the values object has no apiKey member');
ok(!JSON.stringify(keyedDescribe.body).includes('sk-test-123'), 'so no answer can carry the key itself');
eq((await callRoute(gateSettings.makeGateRoutes(fakeSettings, keyedHooks)[2], { body: {} })).body.value.apiKeyConfigured, true, '/status reports the same boolean');
const keyWrite = await callRoute(gateSettings.makeGateRoutes(fakeSettings, keyedHooks)[1], { body: { patch: { apiKey: '  sk-test-123  ' } } });
eq(keyWrite.body.apiKeyConfigured, true, 'a key patch is accepted');
eq(writtenCalls[writtenCalls.length - 1], ['cursor-modes', { gate: { apiKey: 'sk-test-123' } }], 'stored trimmed and plain, under the gate block');
ok(!JSON.stringify(keyWrite.body).includes('sk-test-123'), 'and the write answer does not echo it');
eq((await callRoute(mutateRoute, { body: { patch: { apiKey: 5 } } })).body.message, 'gate ' + BT + 'apiKey' + BT + ' must be a string', 'a non-string key is refused like any other field');
eq((await callRoute(mutateRoute, { body: { patch: { apiKey: '' } } })).body.ok, true, 'an empty string is legal: that is the state of a deployment with no key of its own');

// The alpha seam takes the patch as sent: it installed the gate schema itself,
// so the flat patch is already the shape its own section expects.
const alphaWrites = [];
const alphaSettings = {
	describe: () => [{ ns: 'cursor-modes' }],
	installSection: () => {},
	update: async (ns, body) => { alphaWrites.push([ns, body]); }
};
await callRoute(gateSettings.makeGateRoutes(alphaSettings, gateHooks)[1], { body: { patch: { enabled: true } } });
eq(alphaWrites, [['cursor-modes', { enabled: true }]], 'the installSection seam receives the flat patch, un-nested');

const statusOk = await callRoute(statusRoute, { body: {} });
eq(statusOk.status, 200, '/status answers 200');
eq(Object.keys(statusOk.body.value), ['enabled', 'credential', 'effectiveTimeoutMs', 'allowConfidence', 'workReject', 'lastVerdict', 'apiKeyConfigured'], '/status keeps its seven keys, in order');
eq(statusOk.body.value.effectiveTimeoutMs, 4000, '/status reports the effective timeout');
eq(statusOk.body.value.lastVerdict, null, '/status reports no verdict until one is judged');
const verdictHooks = Object.assign({}, gateHooks, { verdicts: { last: { allow: false, reason: 'judged implementation_work' } } });
eq((await callRoute(gateSettings.makeGateRoutes(fakeSettings, verdictHooks)[2], { body: {} })).body.value.lastVerdict, { allow: false, reason: 'judged implementation_work' }, '/status passes the in-memory verdict through');

// The four ways the namespace can be absent, each with its own reason: a card
// that shows one message for all of them cannot tell the reader what to fix.
eq((await callRoute(gateSettings.makeGateRoutes(undefined, gateHooks)[0], { body: {} })).body, { ok: false, code: 'settings-unavailable', message: 'the settings service is not mounted in this harness build' }, 'no settings service is its own reason');
const failedDescribe = await callRoute(gateSettings.makeGateRoutes({ describe: () => { throw new Error('boom'); } }, gateHooks)[0], { body: {} });
eq(failedDescribe.body.code, 'settings-unavailable', 'a throwing describe() is unavailable');
eq(failedDescribe.body.message, 'settings.describe() failed: boom', 'a throwing describe() is NOT reported as a missing namespace');
const missingNs = await callRoute(gateSettings.makeGateRoutes({ describe: () => [], update: async () => undefined }, gateHooks)[0], { body: {} });
eq(missingNs.body.code, 'settings-unavailable', 'an empty descriptor list is unavailable');
ok(missingNs.body.message.includes('the "cursor-modes" settings namespace is not registered'), 'the refusal names the merged namespace');
ok(missingNs.body.message.includes('no running profile entry with that id'), 'the refusal names the probable cause');
eq((await callRoute(gateSettings.makeGateRoutes({ describe: () => [{ ns: 'cursor-plan' }], update: async () => undefined }, gateHooks)[0], { body: {} })).body.code, 'settings-unavailable', 'the RETIRED cursor-plan namespace no longer satisfies the lookup');

// installGateSection: three generations, newest first, and a loud failure when
// none of them accepts the namespace.
eq(await settingsMod.installGateSection({}, fakeSettings, { enabled: false }, { setSource() {}, onChange() {} }), 'configSchema', 'the 0.1.7 service registers as configSchema');
eq(await gateSettings.installGateSection({}, fakeSettings, { enabled: false }, { setSource() {}, onChange() {} }), 'configSchema', 'gate-settings.js and the settings.js wrapper answer the same way');
const alphaCalls = [];
const alphaOnly = { installSection: (owner, namespace, schema, base, hooks) => { alphaCalls.push([namespace, typeof schema, typeof hooks.setSource]); } };
eq(await gateSettings.installGateSection({}, alphaOnly, { enabled: false }, { setSource() {}, onChange() {} }), 'installSection', 'the alpha seam registers as installSection');
eq(alphaCalls, [['cursor-modes', 'function', 'function']], 'the alpha seam receives the merged namespace, a schema, and both hooks');
let alphaReject = null;
try { await gateSettings.installGateSection({}, { describe: () => [] }, {}, { setSource() {}, onChange() {} }); } catch (reason) { alphaReject = reason.message; }
ok(typeof alphaReject === 'string' && alphaReject.includes('is not registered'), 'a Config without .volatile() cannot pass silently');
let rc2Reject = null;
try { await gateSettings.installGateSection({}, {}, {}, { setSource() {}, onChange() {} }); } catch (reason) { rc2Reject = reason.message; }
ok(typeof rc2Reject === 'string' && rc2Reject.includes('no registration API'), 'a settings service with no seam at all is refused, not silently accepted');
let settingsWrapReject = null;
try { await settingsMod.installGateSection({}, { describe: () => [] }, {}, { setSource() {}, onChange() {} }); } catch (reason) { settingsWrapReject = reason.message; }
ok(typeof settingsWrapReject === 'string' && settingsWrapReject.includes('is not registered'), 'the settings.js wrapper keeps the throw-with-reason contract');

// credentialView: only a boolean ever leaves, so no bridge answer can carry a
// secret.
eq(await gateSettings.credentialView({ resolve: async () => ({ value: 'sk-secret' }) }, 'OPENROUTER_API_KEY'), { ref: 'OPENROUTER_API_KEY', configured: true }, 'a resolved non-empty credential is configured');
eq(await gateSettings.credentialView({ resolve: async () => ({ value: '' }) }, 'REF'), { ref: 'REF', configured: false }, 'an empty value is not configured');
eq(await gateSettings.credentialView({ resolve: async () => { throw new Error('vault locked'); } }, 'REF'), { ref: 'REF', configured: false }, 'a throwing resolver is not configured, not an error');
eq(await gateSettings.credentialView(undefined, 'REF'), { ref: 'REF', configured: false }, 'no credentials service is not configured');
eq(await settingsMod.credentialView({ resolve: async () => ({ value: 'x' }) }, 'R'), { ref: 'R', configured: true }, 'settings.js forwards credentialView unchanged');

// isLoopbackRequest, the red line the whole bridge rests on.
const loopReq = (over) => Object.assign({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4000' } }, over || {});
ok(gateSettings.isLoopbackRequest(loopReq()) === true, 'a 127.0.0.1 request with a 127.0.0.1 host is loopback');
ok(gateSettings.isLoopbackRequest(loopReq({ socket: { remoteAddress: '::1' }, headers: { host: 'localhost:4000' } })) === true, 'the IPv6 loopback with a localhost host is loopback');
ok(gateSettings.isLoopbackRequest(loopReq({ socket: { remoteAddress: '::ffff:127.0.0.1' } })) === true, 'the mapped IPv4 loopback is loopback');
ok(gateSettings.isLoopbackRequest(loopReq({ socket: { remoteAddress: '192.168.0.5' } })) === false, 'another machine is not loopback');
ok(gateSettings.isLoopbackRequest(loopReq({ headers: {} })) === false, 'a request with no host header is refused');
ok(gateSettings.isLoopbackRequest(loopReq({ headers: { host: 'evil.example:4000' } })) === false, 'a foreign host is refused even from 127.0.0.1');
ok(gateSettings.isLoopbackRequest(loopReq({ headers: { host: '127.0.0.1:4000', 'sec-fetch-site': 'cross-site' } })) === false, 'a cross-site fetch is refused');
ok(gateSettings.isLoopbackRequest(loopReq({ headers: { host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000' } })) === true, 'a same-origin page is admitted');
ok(gateSettings.isLoopbackRequest(loopReq({ headers: { host: '127.0.0.1:4000', origin: 'http://evil.example' } })) === false, 'a foreign origin is refused');
ok(gateSettings.isLoopbackRequest(loopReq({ headers: { host: '127.0.0.1:4000', origin: 'not a url' } })) === false, 'an unparseable origin is refused');

// --- the schemastery projection (the settings page reads the Config) ------
// An optional dev dependency: when it cannot be imported the projection block is
// skipped rather than failed, because a missing dependency is not a defect in
// this plugin. Every other assertion in this file still runs.
let z = null;
try {
	z = (await import('@deepseek-ai/schemastery')).default;
} catch {
	console.log('SKIP (schemastery unavailable)');
}
if (z !== null) {
	const index = await load('./lib/index.js');
	ok(typeof z.string().volatile === 'function', 'schemastery provides .volatile(), which the Config depends on');
	ok(typeof index.Config === 'function', 'a schemastery Schema is callable — the Loader reads it that way');
	eq(index.Config['~standard'].vendor, 'schemastery', 'the Config announces the schemastery vendor');
	ok(index.apply.Config === index.Config, 'apply.Config is the exported Config, so the Loader finds the schema');
	const standard = index.Config['~standard'];
	const deployed = standard.validate({ gate: { enabled: true, timeoutMs: 4000 } });
	eq(deployed.issues, undefined, 'the shipped deployment config validates clean');
	const volatileWrite = Symbol.for('cosmokit.volatile.write');
	ok(volatileWrite in deployed.value.gate, 'the gate arrives as a volatile reference from 0.1.7');
	eq(deployed.value.gate.get(), { enabled: true, backend: 'llm', model: '', baseUrl: 'http://127.0.0.1:7899/api/v1', timeoutMs: 4000, allowConfidence: 0.8, workReject: 0.2, apiKeyRef: 'OPENROUTER_API_KEY', apiKey: '' }, 'the volatile reference carries all nine fields with the deployment override kept');
	ok(!!standard.validate({ gate: { allowConfidence: 5 } }).issues, 'allowConfidence above 1 is refused by the schema');
	ok(!!standard.validate({ gate: { timeoutMs: 0 } }).issues, 'timeoutMs below 1 is refused by the schema');
	// SettingsForms.describe() keys on this projection — a verbatim copy of the
	// harness's own volatileForm/plainSchema, so a Config that stops being
	// visible to describe() fails here instead of on the settings page.
	function plainSchema(schema) {
		const result = new z(schema.toJSON());
		const walk = (node) => {
			delete node.meta.volatile;
			for (const child of Object.values(node.dict || {})) walk(child);
			if (node.inner) walk(node.inner);
			for (const child of node.list || []) walk(child);
		};
		walk(result);
		return result;
	}
	function volatileForm(schema) {
		if (schema.meta.volatile) return plainSchema(schema);
		if (schema.type === 'object') {
			const dict = Object.fromEntries(Object.entries(schema.dict || {}).flatMap(([key, child]) => {
				const field = volatileForm(child);
				return field === undefined ? [] : [[key, field]];
			}));
			return Object.keys(dict).length === 0 ? undefined : z.object(dict);
		}
		return undefined;
	}
	const form = volatileForm(new z(index.Config.toJSON()));
	ok(form !== undefined, 'a Config without volatile fields is invisible to describe()');
	eq(Object.keys(form.dict), ['gate'], 'only the gate block is editable — defaultSection stays reserved');
	eq(Object.keys(form.dict.gate.dict), ['enabled', 'backend', 'model', 'baseUrl', 'timeoutMs', 'allowConfidence', 'workReject', 'apiKeyRef', 'apiKey'], 'the settings form projects all nine gate fields, in order');
	const bare = z.object({ gate: z.object({ enabled: z.boolean().default(false) }) });
	eq(volatileForm(new z(bare.toJSON())), undefined, 'counter-proof: the same shape without .volatile() yields no form');
	// A card write, as the Loader commits it: the reference updates in place, so
	// the next judged call sees the edit with no remount.
	const live = standard.validate({ gate: { enabled: true, timeoutMs: 4000 } }).value;
	const next = standard.validate({ gate: Object.assign({}, live.gate.get(), { enabled: false }) }).value;
	live.gate[volatileWrite](next.gate.get());
	eq(live.gate.get().enabled, false, 'a card write reaches the live reference with no remount');
}

// The harness's own settings package: only its absent seam is asserted, because
// which version a profile links is an environment fact, not a plugin contract.
let settingsVersion = null;
try {
	const requireFromHere = createRequire(import.meta.url);
	const entry = requireFromHere.resolve('@deepseek-ai/dsh-settings');
	ok(/dsh-settings/.test(entry), 'dsh-settings resolves from this package');
	settingsVersion = JSON.parse(readFileSync(requireFromHere.resolve('@deepseek-ai/dsh-settings/package.json'), 'utf8')).version;
	ok(typeof settingsVersion === 'string' && settingsVersion.length > 0, 'the resolved dsh-settings has a version: ' + settingsVersion);
	const settingsPkg = await import(new URL('file:///' + entry.replace(/\\/g, '/')).href);
	eq(typeof settingsPkg.SettingsForms, 'function', 'SettingsForms is exported — the projection API the card relies on');
	eq(settingsPkg.installSettingsSection, undefined, 'this build has no module-level installSettingsSection, so installGateSection falls through to its own throw');
} catch (reason) {
	console.log('SKIP (dsh-settings unavailable) — ' + String(reason && reason.message));
}

// ===========================================================================
// 7. The judge answer: askJev must eat a gzip body (the 8 absorbed assertions)
// ===========================================================================
const PLAIN_ANSWER = JSON.stringify({
	answers: { intent: { choice: 'read_only_research' }, work: { noul: 0.15 } },
	usage: { cost: 0.0001 },
	model: 'jev-latest'
});
let judgeCall = null;
function answerWith(bytes) {
	return delegationGate.askJev({
		state: 'read-only probe of a directory listing',
		apiKey: 'test-key',
		baseUrl: 'https://judge.invalid/api/v1',
		timeoutMs: 1000,
		fetchImpl: async (url, init) => {
			judgeCall = { url, init };
			return {
				ok: true,
				status: 200,
				async arrayBuffer() {
					return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				}
			};
		}
	});
}
const gzipped = await answerWith(new Uint8Array(gzipSync(PLAIN_ANSWER)));
eq(gzipped.answers.intent.choice, 'read_only_research', 'a gzip judge answer is read, not treated as a policy verdict');
eq(gzipped.answers.work.noul, 0.15, 'the measured field survives the gunzip');
eq(judgeCall.url, 'https://judge.invalid/api/v1/systemone', 'the judge path is baseUrl + /systemone');
eq(judgeCall.init.method, 'POST', 'the judge is asked with POST');
eq(judgeCall.init.headers['Accept-Encoding'], 'identity', 'the request asks for an uncompressed answer');
eq(JSON.parse(judgeCall.init.body).questions.intent.type, 'choice', 'the questions ride in the request body');
const plainAnswer = await answerWith(new Uint8Array(Buffer.from(PLAIN_ANSWER, 'utf8')));
eq(plainAnswer.answers.intent.choice, 'read_only_research', 'an uncompressed answer still reads');
eq(plainAnswer.answers.work.noul, 0.15, 'the measured field survives the plain path');
let httpBoom = null;
try {
	await delegationGate.askJev({ state: 'x', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) });
} catch (reason) { httpBoom = reason.message; }
eq(httpBoom, 'judge returned HTTP 500', 'a non-2xx answer denies instead of reading the body');
let noTask = null;
try { await delegationGate.askJev({ state: '   ', apiKey: 'k', fetchImpl: async () => ({ ok: true }) }); } catch (reason) { noTask = reason.message; }
eq(noTask, 'nothing to judge: the call carries no task text', 'an empty task never reaches the network');
let noKey = null;
try { await delegationGate.askJev({ state: 'x', apiKey: '', fetchImpl: async () => ({ ok: true }) }); } catch (reason) { noKey = reason.message; }
eq(noKey, 'no judge credential was resolved', 'a missing credential never reaches the network');
eq(delegationGate.GATE_TOOLS, ['subagent', 'send_message'], 'the judge only gates the two delegation tools');

// ===========================================================================
// 8. The client half (skipped, never failed, while lib/client.js is unwritten)
// ===========================================================================
let clientSpec = null;
try {
	const loaded = {};
	globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded.spec = spec; } } };
	new Function('window', 'document', readFileSync(resolve(here, 'lib', 'client.js'), 'utf8'))(globalThis.window, undefined);
	if (loaded.spec === undefined) throw new Error('the bundle never called window.__ModuleLoader__.load');
	if (loaded.spec.id !== 'dsh-cursor-modes') throw new Error('the bundle announced id ' + String(loaded.spec.id));
	if (typeof loaded.spec.factory !== 'function') throw new Error('the bundle exposes no factory');
	clientSpec = loaded.spec;
} catch (reason) {
	clientSpec = null;
	console.log('SKIP (client bundle not written yet) — ' + String(reason && reason.message));
}
if (clientSpec !== null) {
	eq(clientSpec.id, 'dsh-cursor-modes', 'the client bundle announces the merged plugin id');
	// The card's action row waits for the host's dispatch answer: with a plan file
	// present the state starts null, and it would stay null here because this fake
	// React never runs effects and never re-renders. planState stands in for that
	// answer, and fileTodos for the checklist the bridge reads out of the plan file,
	// so every render below is one a real browser eventually gets.
	// The card calls its five hooks before any early return, so the third call is
	// always the dispatch slot and the fifth the checklist; renderCard resets that
	// ordinal per render.
	let planState = false;
	let fileTodos = [];
	let hookIndex = 0;
	const react = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		Fragment: { fragment: true },
		useState: (value) => {
			const slot = hookIndex;
			hookIndex += 1;
			const seeded = slot === 2 ? planState : slot === 4 ? fileTodos : value;
			return [seeded, () => {}];
		},
		useRef: (value) => ({ current: value }),
		useEffect: () => {},
		memo: (component) => component
	};
	const primitives = { MarkdownText: () => null, Menu: () => null, IconChevronDownOutlineRegular: () => null };
	const client = clientSpec.factory((name) => {
		if (name === 'react') return react;
		if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
		throw new Error('the client asked for an unexpected module: ' + name);
	});
	eq(Object.keys(client).sort(), ['BUILD_BRIDGE', 'BUILD_TARGETS', 'MODE_BRIDGE', 'MODE_IDS', 'PENDING_BRIDGE', 'apply', 'createBuild', 'createSelection', 'currentMode', 'gateCardHelpers', 'inject', 'locales', 'pendingOverride'], 'the client exports the thirteen names the host and the self-check read');

	// --- the vocabulary the two halves must agree on -----------------------
	eq(client.BUILD_TARGETS, { multi: 'multi', default: 'default' }, 'the client build targets are the merged ids');
	eq(client.MODE_IDS, ['default', 'cursorPlan', 'cursorMulti'], 'the chip still speaks the retired vocabulary — the host asModeId is what maps it');
	eq(client.BUILD_BRIDGE, build.BUILD_PATH, 'client and host agree on the build path');
	eq(client.MODE_BRIDGE, sw.BRIDGE_PREFIX, 'client and host agree on the pending bridge');
	eq(client.PENDING_BRIDGE, sw.BRIDGE_PREFIX, 'the stage/clear transport posts to that same bridge');
	eq(client.inject, ['slots', 'uiConversation', 'locale'], 'the client declares exactly the three services it reads');
	// The chip's stage() must accept the retired ids, and the host must map
	// them: this pair is the whole cross-version contract.
	ok(client.MODE_IDS.every((id) => sw.asModeId(id) !== undefined), 'every client chip id is a target the host understands');

	// --- currentMode / pendingOverride -------------------------------------
	eq(client.currentMode({}), 'default', 'no projection at all folds to default');
	eq(client.currentMode({ mode: { mode: 'plan' } }), 'cursorPlan', 'the merged projection plan is Cursor Plan on the chip');
	eq(client.currentMode({ mode: { mode: 'multi' } }), 'cursorMulti', 'the merged projection multi is Cursor Multi on the chip');
	eq(client.currentMode({ mode: { mode: 'default' } }), 'default', 'the merged projection default is default');
	eq(client.currentMode({ plan: { mode: 'plan' } }), 'cursorPlan', 'the official plan projection is read too');
	eq(client.currentMode({ plan: true }), 'cursorPlan', 'a bare plan latch is Cursor Plan');
	eq(client.currentMode({ plan: true, mode: { mode: 'multi' } }), 'cursorPlan', 'the official plan projection outranks the multi latch');
	eq(client.pendingOverride('default', null), null, 'nothing staged is no override');
	eq(client.pendingOverride('default', 'cursorPlan'), 'cursorPlan', 'a staged choice overrides the committed label');
	eq(client.pendingOverride('cursorPlan', 'cursorPlan'), null, 'a staged choice equal to the committed one is not pending');

	// --- apply: three seats, one namespace, two dictionaries ---------------
	const registered = [];
	const definitions = [];
	let localeCall = null;
	const clientCtx = {
		effect: (body) => { body(); return () => {}; },
		locale: {
			register: (namespace, dictionaries) => { localeCall = { namespace, dictionaries }; return () => {}; },
			bind: (namespace) => (key) => key
		},
		uiConversation: { events: { register: (definition) => { definitions.push(definition); return () => {}; } } },
		slots: {
			inject: (name, callback) => callback(),
			register: (options, component) => { registered.push({ options, component }); return () => {}; }
		}
	};
	client.apply(clientCtx);
	eq(registered.map((entry) => entry.options.name).sort(), ['conversation.chat.node', 'conversation.chat.turnTail', 'conversation.input.left', 'settings.plugins.tab'], 'the merged client takes four seats, including the switch-notice row');
	eq(localeCall.namespace, 'cursorModes', 'the two retired dictionaries merged into one namespace');
	const zh = localeCall.dictionaries.zh;
	const en = localeCall.dictionaries.en;
	eq(Object.keys(zh).sort(), Object.keys(en).sort(), 'both dictionaries carry the same keys, so no card falls back to a raw key');
	eq(Object.keys(en).length, 54, 'the merged dictionary has the fifty-four keys the four cards read');
	eq(en['card.expand'], 'Show full plan', 'the English expand label');
	eq(en['card.view'], 'View Plan', 'the English view label');
	eq(en['card.buildMulti'], 'Build in Multi', 'the English label of the left Build button');
	eq(en['card.buildDefault'], 'Build in Default', 'the English label of the right Build button');
	eq(zh['card.buildMulti'], 'Build in Multi', 'the Chinese label keeps the button wording — it names an action the model also reads');
	eq(zh['card.buildDefault'], 'Build in Default', 'the Chinese label of the right Build button');
	eq(en['chip.mode.cursorPlan'], 'Cursor Plan', 'the chip names Cursor Plan');
	eq(en['chip.mode.cursorMulti'], 'Cursor Multi', 'the chip names Cursor Multi');
	eq(en['chip.mode.default'], 'default', 'the chip names the default mode');
	ok(typeof zh['chip.stageFailed'] === 'string' && zh['chip.stageFailed'].length > 0, 'the failed-stage hint exists, so a dropped chip click is visible');
	const turnTail = registered.find((entry) => entry.options.name === 'conversation.chat.turnTail');
	/** One PlanCard render, with the hook ordinal the fake useState keys on reset. */
	const renderCard = (props) => {
		hookIndex = 0;
		return turnTail.component(props);
	};
	const settingsTab = registered.find((entry) => entry.options.name === 'settings.plugins.tab');
	const chipSeat = registered.find((entry) => entry.options.name === 'conversation.input.left');
	const noticeSeat = registered.find((entry) => entry.options.name === 'conversation.chat.node');
	eq(turnTail.options.id, 'cursor-modes', 'the turn-tail entry declares the merged id');
	eq(settingsTab.options.id, 'cursor-modes', 'the settings tab is the merged namespace');
	eq(settingsTab.options.order, 20, 'the settings tab keeps its plugin order, so it stays in its slot position');
	eq(chipSeat.options.id, 'mode-chip', 'the composer chip keeps its id');
	ok(typeof chipSeat.options.inject === 'function', 'the chip seat injects its own selection handle');

	// --- the switch notice row ---------------------------------------------
	// The shipped projection files a non-user source under `context`, which
	// chat-visibility hides; this Definition re-projects the very same durable
	// event as a visible row, and only this plugin's own switch notice.
	const noticeDef = definitions.find((definition) => definition.kind === 'cursor-mode-notice');
	ok(noticeDef !== undefined, 'the client registers the switch-notice Definition');
	eq(noticeDef.target, 'chat', 'it projects onto the chat target, not trajectory or context');
	eq(noticeSeat.options.key, 'cursor-mode-notice', 'the keyed renderer owns that kind');
	const noticeEvent = {
		type: 'user/message',
		seq: 31,
		time: 1792762690081,
		surfaceOp: 'append',
		data: {
			id: 'm-notice-1',
			source: { kind: 'dsh-cursor-modes', form: 'notice', summary: 'dsh-cursor-modes: switched to plan mode' }
		}
	};
	eq(noticeDef.match(noticeEvent), { id: 'm-notice-1', role: 'start' }, 'a switch notice starts one row, keyed by its message id');
	eq(noticeDef.match({ type: 'user/message', surfaceOp: 'append', data: { id: 'm-2', source: { kind: 'user' } } }), null, 'a human message is not claimed');
	eq(noticeDef.match({ type: 'user/message', surfaceOp: 'append', data: { id: 'm-3', source: { kind: 'dsh-modes', form: 'notice', summary: 'another plugin said so' } } }), null, 'another producer\'s notice is not a switch line');
	eq(noticeDef.match({ type: 'user/message', surfaceOp: 'append', data: { id: 'm-4', source: { kind: 'dsh-cursor-modes', form: 'summary' } } }), null, 'only form=notice qualifies');
	const noticeNode = noticeDef.buildViewNode({
		key: 'ctx-1',
		kind: 'cursor-mode-notice',
		id: 'm-notice-1',
		start: { event: noticeEvent, location: { kind: 'session' } },
		state: { seq: 31, time: 1792762690081, summary: 'dsh-cursor-modes: switched to plan mode' }
	});
	eq(noticeNode.kind, 'cursor-mode-notice', 'the row materializes under its own renderer kind');
	eq(noticeNode.visibility, 'visible', 'ordinary Context would be hidden; this row is visible');
	eq(noticeNode.groupTree, 'input', 'input position keeps it out of the completed-turn process fold, so it survives a reload');
	eq(noticeNode.anchorSeq, 31, 'the row sits at the notice event sequence');
	eq(noticeNode.data.summary, 'dsh-cursor-modes: switched to plan mode', 'the row carries exactly the one line the host recorded');
	eq(noticeDef.buildViewNode({ key: 'ctx-2', kind: 'cursor-mode-notice', id: 'm-2', start: { event: noticeEvent, location: { kind: 'session' } }, state: { seq: 40, time: 0, summary: null } }), null, 'a notice with no summary renders nothing');
	const noticeLine = noticeSeat.component({ node: noticeNode, t: (key) => key });
	eq(noticeLine.children, ['dsh-cursor-modes: switched to plan mode'], 'the component renders the summary as its only line');
	eq(noticeLine.props['data-cursor-mode-notice'], '1', 'the row carries the DOM hook the acceptance probe reads');

	// --- the card renders two Build buttons, Multi left of Default ---------
	const planTurn = {
		turn: 7,
		status: 'closed',
		steps: [],
		data: {
			get: (key) => (key === 'cursor-plan' ? { plans: [{
				seq: 12,
				argsRaw: JSON.stringify({ plan: '# Land it\n\nBody line', overview: 'Ov' }),
				resultText: 'Plan file: C:\\tmp\\x.plan.md\n'
			}] } : undefined),
			subscribe: () => () => {}
		}
	};
	const clicks = [];
	const tree = renderCard({
		turn: planTurn,
		seq: 20,
		openFile: () => {},
		t: (key) => en[key] || key,
		buildPlan: async (choice) => { clicks.push(choice); return null; }
	});
	function buttonsOf(node, found) {
		const bag = found || [];
		if (node === null || typeof node !== 'object') return bag;
		if (Array.isArray(node)) { for (const child of node) buttonsOf(child, bag); return bag; }
		if (node.type === 'button') bag.push(node);
		if (Array.isArray(node.children)) for (const child of node.children) buttonsOf(child, bag);
		return bag;
	}
	const textOf = (node) => (Array.isArray(node.children) ? node.children.join('') : String(node.children));
	const buttons = buttonsOf(tree);
	eq(buttons.map(textOf), ['Show full plan', 'View Plan', 'Build in Multi', 'Build in Default'], 'Multi sits left of Default in the action row');
	ok(buttons.every((button) => button.props.type === 'button'), 'every action is a real button element, so it is keyboard reachable');
	eq(buttons[2].props.onClick(), undefined, 'a Build click returns undefined synchronously — the card shows its own spinner');
	await flush();
	eq(buttons[3].props.onClick(), undefined, 'the second Build click returns undefined too');
	await flush();
	eq(clicks, ['multi', 'default'], 'the left button asks for multi, the right for default');

	// --- the execution checklist: rendered by the card, folded with the body ---
	// The plan MARKDOWN carries its two sections; the checklist is a third part
	// built from the `todos` argument, and the session's `todos` projection takes
	// over the moment one exists. Two different things are asserted below: the
	// list is the card's own render (never text the model wrote into the plan
	// body), and it mounts INSIDE the clamped body container so the 11em fold
	// covers it. The second one is new (2026-10-24) — the list used to be the
	// body's sibling, which the fold never touched.
	const nodesOf = (node, found) => {
		const bag = found || [];
		if (node === null || typeof node !== 'object') return bag;
		if (Array.isArray(node)) { for (const child of node) nodesOf(child, bag); return bag; }
		bag.push(node);
		if (Array.isArray(node.children)) for (const child of node.children) nodesOf(child, bag);
		return bag;
	};
	const checklistOf = (root) => nodesOf(root).find((node) => node.props && node.props['data-plan-checklist'] === '1');
	// The action row is the host's answer, never a guess: nothing while the read
	// is in flight, and one stamp instead of the buttons once a build ran.
	const rowOf = (root) => buttonsOf(root).map(textOf);
	const plainProps = { turn: planTurn, seq: 20, openFile: () => {}, t: (key) => en[key] || key, buildPlan: async () => null };
	planState = null;
	eq(rowOf(renderCard(plainProps)), ['Show full plan', 'View Plan'],
		'while the dispatch read is in flight no Build button exists: nothing flashes and then vanishes');
	planState = true;
	const dispatchedTree = renderCard(plainProps);
	eq(rowOf(dispatchedTree), ['Show full plan', 'View Plan'], 'a dispatched plan drops both Build buttons');
	eq(nodesOf(dispatchedTree).find((node) => node.props && node.props['data-plan-dispatched'] === '1')?.children, ['Dispatched'],
		'and shows the Dispatched stamp in their place');
	planState = false;
	fileTodos = [];
	eq(checklistOf(tree), undefined, 'a plan with no checklist renders no checklist block at all');
	const checklistArgs = {
		plan: '# Land it\n\n## 方案设计\n\nPlain language.\n\n## 技术细节\n\n- a\n',
		overview: 'Ov',
		todos: [
			{ id: 'a', content: 'back up', status: 'pending' },
			{ id: 'b', content: 'restart', status: 'pending' }
		]
	};
	const checklistTurn = {
		turn: 8,
		status: 'closed',
		steps: [],
		data: {
			get: (key) => (key === 'cursor-plan' ? { plans: [{
				seq: 30,
				argsRaw: JSON.stringify(checklistArgs),
				resultText: 'Plan file: C:\\tmp\\y.plan.md\n'
			}] } : undefined),
			subscribe: () => () => {}
		}
	};
	// The FILE is the one source: the create_plan argument snapshot carries the same
	// todos and must NOT be what the card draws - only the bridge's file read is.
	eq(checklistOf(renderCard({ turn: checklistTurn, seq: 40, openFile: () => {}, t: (key) => en[key] || key, buildPlan: async () => null })), undefined,
		'the create_plan snapshot alone renders no checklist: the plan file is the source of truth');
	fileTodos = checklistArgs.todos;
	const checklistTree = renderCard({
		turn: checklistTurn,
		seq: 40,
		openFile: () => {},
		t: (key) => en[key] || key,
		buildPlan: async () => null
	});
	const checklistBlock = checklistOf(checklistTree);
	ok(checklistBlock !== undefined, 'the card renders a checklist block after the body');
	eq(checklistBlock && checklistBlock.props.className, 'Sc7pKm_checklist', 'the block is the body continued: a spacing class, never the card class, so it is not a second card');
	ok(!/card/.test(String(checklistBlock && checklistBlock.props.className)), 'and nothing in that name can style it as a box');
	const checklistNodes = nodesOf(checklistBlock);
	const headings = checklistNodes.filter((node) => node.props && node.props.text === '## 执行清单');
	eq(headings.length, 1, 'exactly one checklist heading');
	ok(headings[0] !== undefined && typeof headings[0].type === 'function', 'the heading is rendered by MarkdownText from a literal ## line, so it sits level with the body sections');
	const progressOf = (root) => nodesOf(root).find((node) => node.props && node.props.className === 'Sc7pKm_progress');
	eq(progressOf(checklistBlock)?.children, ['0 / 2'], 'the counter reads completed / total from the plan snapshot');
	const rowsOf = (root) => nodesOf(root).filter((node) => node.props && node.props['data-todo-status'] !== undefined);
	eq(rowsOf(checklistBlock).map((node) => node.props['data-todo-status']), ['pending', 'pending'], 'one row per todo, pending before anything is written');
	eq(nodesOf(checklistTree).filter((node) => node.type === 'hr').length, 0, 'no horizontal rule separates the checklist from the body');
	ok(
		checklistNodes.every((node) => !(node.props && /_card|divider|separator/.test(String(node.props.className || '')))),
		'and nothing in it reuses the card or divider class, so it cannot look like a separate box'
	);
	// --- where it mounts: inside the clamped body, never beside it ---------
	// The fold is `max-height:11em; overflow:hidden` on the body div, so a list
	// mounted beside that div is outside the clamp: a two-line plan still printed
	// its whole checklist. Everything below walks the RENDER TREE (parent, child,
	// ancestor chain). A lookup by class or by data attribute cannot see where a
	// node sits, which is why the sibling version passed the old table.
	const pathToNode = (root, target, trail) => {
		if (root === null || typeof root !== 'object') return null;
		if (Array.isArray(root)) {
			for (const child of root) {
				const hit = pathToNode(child, target, trail);
				if (hit !== null) return hit;
			}
			return null;
		}
		const here2 = (trail || []).concat([root]);
		if (root === target) return here2;
		if (!Array.isArray(root.children)) return null;
		for (const child of root.children) {
			const hit = pathToNode(child, target, here2);
			if (hit !== null) return hit;
		}
		return null;
	};
	const kidsOf = (node) => (node && Array.isArray(node.children) ? node.children : []);
	const foldChain = pathToNode(checklistTree, checklistBlock) || [];
	const bodyAncestor = foldChain[foldChain.length - 2];
	const cardAncestor = foldChain[foldChain.length - 3];
	eq(foldChain.length, 3, 'the checklist hangs two levels under the card — body container, then checklist — with no wrapper of its own');
	eq(bodyAncestor && bodyAncestor.props.className, 'Sc7pKm_body',
		'its PARENT is the body container, and it is the collapsed one: the element carrying the 11em clamp');
	ok(foldChain.some((node) => node.props && (node.props.className === 'Sc7pKm_body' || node.props.className === 'Sc7pKm_bodyOpen')),
		'the ancestor chain of the list carries a body class, so the fold governs it and a short plan cannot spill the list');
	eq(cardAncestor && cardAncestor.props['data-created-plan'], '1', 'two levels up is still the plan card, so the list never escapes the card either');
	ok(!kidsOf(cardAncestor).includes(checklistBlock), 'the list is NOT the body\'s sibling any more — that arrangement is exactly the bug');
	eq(kidsOf(bodyAncestor).map((node) => (node.props && node.props.className) || 'markdown').join(','), 'markdown,Sc7pKm_checklist',
		'the body holds the plan text first and the list last, with nothing between them: one continuous read');
	ok(String(kidsOf(bodyAncestor)[0] && kidsOf(bodyAncestor)[0].props && kidsOf(bodyAncestor)[0].props.text || '').startsWith('## 方案设计'),
		'and that first child is still the plan text itself, not the list');
	// The action row is the same question in reverse: a button inside the clamp
	// would be half-drawn or unreachable, so no action may sit in there.
	const foldButtons = buttonsOf(checklistTree);
	eq(foldButtons.length, 4, 'the four actions are still on the card');
	ok(foldButtons.every((button) => (pathToNode(checklistTree, button) || []).every((node) => ![ 'Sc7pKm_body', 'Sc7pKm_bodyOpen' ].includes(node.props && node.props.className))),
		'no action sits inside the clamped body: Show full plan, View Plan and both Build buttons stay unclipped');
	const actionsOf = kidsOf(cardAncestor).find((node) => node.props && node.props.className === 'Sc7pKm_actions');
	ok(actionsOf !== undefined && buttonsOf(actionsOf).length === 4,
		'the action row is the body\'s SIBLING under the card and holds all four buttons');
	// The clamp itself: a render tree cannot express CSS, so the two rules the
	// fold depends on are read out of the bundle by their exact text.
	const clientSource = readFileSync(resolve(here, 'lib', 'client.js'), 'utf8');
	ok(clientSource.includes('.Sc7pKm_body{color:var(--dsw-alias-label-primary);max-height:11em;overflow:hidden}'),
		'the collapsed body still clamps at 11em with overflow hidden — the list is folded by this rule, not by one of its own');
	ok(clientSource.includes('.Sc7pKm_bodyOpen{color:var(--dsw-alias-label-primary);max-height:none}'),
		'and expanding lifts the clamp, so the list opens in full with the plan');
	ok(clientSource.includes('.Sc7pKm_checklist{margin:18px 0 0}'),
		'the checklist class is still a top margin only — no border, no rule, no background — so it reads as the body continuing');
	// The FILE's statuses are what the card draws: a completed item is struck through
	// and dimmed, the working one keeps the hollow box with a tint and says 进行中.
	// The session projection is handed something contradictory on purpose - the card no
	// longer reads it, so the rows below can only come from the file.
	fileTodos = [
		{ content: 'back up', status: 'completed' },
		{ content: 'run the checks', status: 'in_progress' }
	];
	const liveTree = renderCard({
		turn: checklistTurn,
		seq: 40,
		openFile: () => {},
		t: (key) => en[key] || key,
		buildPlan: async () => null,
		useProjection: (key) => (key === 'todos' ? [
			{ content: 'SESSION ONLY', status: 'pending' },
			{ content: 'SESSION ONLY 2', status: 'pending' }
		] : undefined)
	});
	const liveBlock = checklistOf(liveTree);
	const liveNodes = nodesOf(liveBlock);
	eq(progressOf(liveBlock)?.children, ['1 / 2'], "the plan file's statuses drive the counter");
	const liveRows = rowsOf(liveBlock);
	eq(liveRows.map((node) => node.props['data-todo-status']), ['completed', 'in_progress'], 'the file statuses replace the pending ones, and the session projection is ignored');
	ok(String(liveRows[0].props.className).includes('Sc7pKm_todoDone'), 'a completed row is dimmed and struck through');
	eq(liveNodes.find((node) => node.props && node.props.className === 'Sc7pKm_boxDone')?.children, ['✓'], 'a completed item shows a tick in a filled box');
	ok(liveNodes.some((node) => node.props && node.props.className === 'Sc7pKm_boxActive'), 'the working item keeps the hollow box');
	ok(liveNodes.some((node) => Array.isArray(node.children) && node.children.length === 1 && node.children[0] === '进行中'), 'and says 进行中 next to it');
	// The click carries the list the card is showing, so the host can write it.
	const clickArgs = [];
	fileTodos = [...checklistArgs.todos];
	const todoClickTree = renderCard({
		turn: checklistTurn,
		seq: 40,
		openFile: () => {},
		t: (key) => en[key] || key,
		buildPlan: async (...args) => { clickArgs.push(args); return null; }
	});
	buttonsOf(todoClickTree)[2].props.onClick();
	await flush();
	eq(clickArgs.length, 1, 'a Build click on a checklist card calls the injected build once');
	eq(clickArgs[0][0], 'multi', 'with the button choice it names');
	eq(clickArgs[0][1]?.length, 2, 'and hands over both checklist items');
	eq((clickArgs[0][1] || []).map((todo) => todo.content), ['back up', 'restart'], 'with the contents the card is showing');

	// --- a click is (stage the target, then write the message) -------------
	const calls = [];
	const buildClick = client.createBuild('s-1', async (path, body) => { calls.push({ path, body }); return { ok: true }; });
	eq(await buildClick('multi'), null, 'a healthy click reports no failure');
	eq(calls, [
		{ path: '/api/dsh-cursor-modes/switch/stage', body: { sessionId: 's-1', target: 'multi' } },
		{ path: '/api/dsh-cursor-modes/build', body: { sessionId: 's-1', choice: 'multi' } }
	], 'Build in Multi stages the merged mode first, then writes the message');
	calls.length = 0;
	eq(await buildClick('default'), null, 'the default click is healthy too');
	eq(calls, [
		{ path: '/api/dsh-cursor-modes/switch/stage', body: { sessionId: 's-1', target: 'default' } },
		{ path: '/api/dsh-cursor-modes/build', body: { sessionId: 's-1', choice: 'default' } }
	], 'Build in Default stages the default mode first, then writes the message');
	calls.length = 0;
	eq(await buildClick('multi', [{ id: 'a', content: 'step', status: 'pending' }]), null, 'a click carrying the checklist is healthy');
	eq(calls, [
		{ path: '/api/dsh-cursor-modes/switch/stage', body: { sessionId: 's-1', target: 'multi' } },
		{ path: '/api/dsh-cursor-modes/build', body: { sessionId: 's-1', choice: 'multi', todos: [{ content: 'step', status: 'pending' }] } }
	], 'the checklist rides the build body with the id dropped: todo_write takes content + status');
	calls.length = 0;
	eq(await buildClick('multi', []), null, 'an empty checklist is a healthy click too');
	eq(calls[1].body, { sessionId: 's-1', choice: 'multi' }, 'and writes no todos key at all');
	const stageRefused = client.createBuild('s-1', async (path) => (path.slice(-6) === '/stage' ? { ok: false, message: 'nope' } : { ok: true }));
	eq(await stageRefused('multi'), 'the mode switch refused: nope', 'a refused stage aborts the build instead of building in the wrong mode');
	const rolledBack = [];
	const buildRefused = client.createBuild('s-1', async (path) => {
		rolledBack.push(path);
		return path === build.BUILD_PATH ? { ok: false, message: 'no live agent' } : { ok: true };
	});
	eq(await buildRefused('multi'), 'the build refused: no live agent', 'a refused build is reported, not swallowed');
	eq(rolledBack, ['/api/dsh-cursor-modes/switch/stage', '/api/dsh-cursor-modes/build', '/api/dsh-cursor-modes/switch/clear'], 'a failed build retracts the staged mode so it cannot leak onto the next send');
	eq(await buildClick('sideways'), 'unknown build choice: sideways', 'an unknown choice never reaches a bridge');
	const throwingTransport = client.createBuild('s-1', async () => { throw new Error('bridge down'); });
	eq(await throwingTransport('multi'), 'bridge down', 'a transport that throws becomes the reported failure');

	// --- the staged chip choice retires once the host consumed it ----------
	const posted = [];
	const selection = client.createSelection('session-retire', async (path, body) => { posted.push({ path, body }); return { ok: true }; });
	await selection.stage('cursorPlan');
	eq(selection.read(), 'cursorPlan', 'a staged chip choice is remembered locally');
	eq(selection.failure(), null, 'a healthy stage reports no failure');
	selection.reconcile('default');
	eq(selection.read(), 'cursorPlan', 'a committed mode that differs from the staged one does NOT retire it');
	selection.reconcile('cursorPlan');
	eq(selection.read(), null, 'a committed mode equal to the staged one retires it — the host already applied the choice');
	eq(posted, [{ path: '/stage', body: { sessionId: 'session-retire', target: 'cursorPlan' } }], 'retiring posts nothing: the host dropped its own copy at the send');
	const forced = [];
	const forcedSelection = client.createSelection('session-forced', async (path, body) => { forced.push({ path, body }); return { ok: true }; });
	await forcedSelection.stage('cursorPlan');
	forcedSelection.reconcile('default');
	forcedSelection.reconcile('cursorMulti');
	eq(forcedSelection.read(), null, 'a committed mode that skips the staged one retracts the choice');
	eq(forced.map((entry) => entry.path), ['/stage', '/clear'], 'and it clears the host copy too');
	eq(forced[1].body, { sessionId: 'session-forced' }, 'the clear carries only the session id');
	const outstanding = [];
	const outstandingSelection = client.createSelection('session-outstanding', async (path, body) => { outstanding.push({ path, body }); return { ok: true }; });
	await outstandingSelection.stage('cursorMulti');
	outstandingSelection.reconcile('plan');
	outstandingSelection.reconcile('plan');
	eq(outstandingSelection.read(), 'cursorMulti', 'a stage that is still outstanding survives repeat reconciles');
	eq(client.pendingOverride('plan', outstandingSelection.read()), 'cursorMulti', 'and keeps overriding the chip label');
	eq(outstanding.length, 1, 'an outstanding stage posts once and is never re-posted');
	let unknownStage = null;
	try { outstandingSelection.stage('plan'); } catch (reason) { unknownStage = reason.message; }
	eq(unknownStage, 'unknown mode: plan', 'the chip refuses the host vocabulary — it stages cursorPlan, not plan');
	const broken = client.createSelection('session-broken', async (path) => {
		if (path === '/clear') return { ok: true };
		throw new Error('bridge down');
	});
	await broken.stage('cursorPlan');
	await flush();
	eq(broken.failure(), 'bridge down', 'a rejected stage is remembered, so the chip can say the host never heard');
	eq(broken.read(), 'cursorPlan', 'and the local choice is kept, so the retry has something to retry with');
	await broken.clear();
	eq(broken.read(), null, 'an explicit clear always drops the local choice');
	eq(broken.failure(), null, 'a clear that reaches the host also drops the stale failure');
}

// --- summary --------------------------------------------------------------
for (const failure of failures) console.error('FAIL: ' + failure);
console.log('self-check-bridge: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) process.exit(1);
