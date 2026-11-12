#!/usr/bin/env node
// self-check-runtime.mjs — assert-based, node straight up, no framework.
//
// Runs the REAL apply() against a stub cordis context and then drives the real
// handlers, so the wiring a pure-module check cannot reach is proven against
// shipped code: the projection registration, both policy sections, both
// commands, both tools, and the ONE pre-execute gate whose internal order is the
// point of the merge (blueprint §5.4).
//
// Ported from dsh-cursor-plan/self-check-runtime.mjs. Every "exactly one" below
// is a merge invariant, not a leftover: a second tools/pre-execute would mean
// the two deleted owners came back, and the handler count of 1 is what makes the
// §5.4 ordering assertions meaningful at all.
//
// Run: node self-check-runtime.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { GATE_DEFAULTS, NOTICE_PLUGIN } from './lib/cursor-plan.js';
import { BUILD_PATH, BUILD_TARGETS, buildText } from './lib/build.js';
import { GATE_BRIDGE_PREFIX, GATE_SETTINGS_NS, installGateSection, makeGateRoutes } from './lib/gate-settings.js';
import { GRANT, LIMIT, quotaOf, spentOf } from './lib/gate.js';
import { gateOf } from './lib/multi.js';
// The event name is read from the projection, never re-spelled here: the merged
// plugin appends ONE cursormodes/state per switch, and an event rename that this
// file hard-coded would silently leave the fake session folding nothing.
import { withTeamTails } from './lib/multi-prompt.js';
import { MODE_EVENT, MODE_KEY, MODE_RECORD, PLAN_DOC_RECORD, setModeEventAppend } from './lib/projection.js';
import { MODE_RULES, UI_BLOCK_SENTENCE, UI_BLOCK_SENTENCE_WITHOUT_TOOL } from './lib/prompts.js';

let passed = 0;
const failures = [];
function ok(cond, label) {
	if (cond) {
		passed += 1;
		return;
	}
	failures.push(label);
}
function eq(actual, expected, label) {
	if (Object.is(actual, expected)) {
		passed += 1;
		return;
	}
	failures.push(label + ' — expected ' + show(expected) + ', got ' + show(actual));
}
function same(actual, expected, label) {
	try {
		assert.deepStrictEqual(actual, expected);
		passed += 1;
	} catch {
		failures.push(label + ' — expected ' + show(expected) + ', got ' + show(actual));
	}
}
function matches(value, pattern, label) {
	ok(typeof value === 'string' && pattern.test(value), label + ' — got ' + show(value));
}
function show(value) {
	if (typeof value === 'string') return JSON.stringify(value);
	try {
		const text = JSON.stringify(value);
		return text === undefined ? String(value) : text;
	} catch {
		return String(value);
	}
}

// Since 0.2.3 the commit writes a host PLUGIN RECORD through `appendPluginRecord`,
// which only accepts a real host Session. The fake Sessions below cannot receive
// it, so they observe the same call through this seam; self-check-fold.mjs proves
// what the shipped writer stamps on a real Session (type + `ignorable: true`).
setModeEventAppend((session, type, data) => session.append(type, data));

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The host dsh bin. apply() calls registerModeEventTypes(process.argv) FIRST,
 * and that walks the argv path up to the live @deepseek-ai/dsh-session
 * vocabulary Set — so an unresolvable bin fails the whole mount. Derived from
 * this package's own node_modules chain (with the launcher profile layout as a
 * fallback), never hard-coded: the check has to survive a moved pack, which is
 * exactly what the legacy hard-coded path did not.
 */
function findHostBin() {
	let dir = here;
	for (let step = 0; step < 10; step += 1) {
		const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
		if (existsSync(candidate)) return candidate;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	const profile = process.env.USERPROFILE;
	if (profile !== undefined && profile !== '') {
		const legacy = join(profile, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
		if (existsSync(legacy)) return legacy;
	}
	return undefined;
}

const hostBin = findHostBin();
ok(typeof hostBin === 'string', 'the host dsh bin resolves from this package tree (registerModeEventTypes needs it): ' + String(hostBin));

const fakeHome = mkdtempSync(join(tmpdir(), 'cursor-modes-home-'));
const realProfile = process.env.USERPROFILE;
const realDshHome = process.env.DSH_HOME;
process.env.USERPROFILE = fakeHome;
// isExistingUiBlock() reads DSH_HOME, so pin it inside the throwaway home: a
// .uiblock exemption check must not depend on the machine's real ~/.dsh.
process.env.DSH_HOME = join(fakeHome, '.dsh');

//
// Default shape = the 4000 deployment: create_ui_block mounted, Agent Teams not.
// The team branch is exercised by flipping `spawn_teammate` below, which stands in
// for a host that mounts it (a mount is fixed for the life of the process).
/** Which optional tools the stub host reports as installed. */
const installed = { create_ui_block: true, spawn_teammate: false };

/** Stub cordis context capturing everything the plugin registers. */
function makeContext(settingsService) {
	const captured = {
		handlers: new Map(),
		sections: [],
		/** Dynamic runtime-context contributions (the mode marker lives here). */
		contexts: [],
		projections: new Map(),
		tools: [],
		commands: [],
		/** Every inject this plugin makes, in order; the first is the core host set. */
		injects: [],
		injectedWith: undefined,
		routes: [],
		effects: 0,
		/** The live agent registry the build route reads. */
		agents: new Map()
	};
	/** Every logger call, so a check can read the judgement trail back. */
	const logged = [];
	const host = {
		logger: {
			info: (...args) => logged.push(args),
			warn: (...args) => logged.push(args),
			error: (...args) => logged.push(args)
		},
		// The delegation gate resolves its credential on every judged call.
		get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'stub-credential' }) } : undefined),
		on(name, handler) {
			const list = captured.handlers.get(name) ?? [];
			list.push(handler);
			captured.handlers.set(name, list);
		},
		systemPrompt: {
			section(definition) {
				captured.sections.push(definition);
			},
			// A separate registry from sections: the marker must NOT be a section,
			// or it would sit in the cached prefix and defeat the whole change.
			context(definition) {
				captured.contexts.push(definition);
			}
		},
		sessionProjections: {
			register(definition) {
				captured.projections.set(definition.key, definition);
			},
			stateOf: (session, key) => session.projected.get(key)
		},
		tools: {
			register(definition) {
				captured.tools.push(definition);
			},
			// Two switches, because the merged plugin has two optional-tool
			// exemptions: create_ui_block (plan mode's draft half-sentence) and
			// spawn_teammate (multi mode's team tail). Default both installed so each
			// section renders its longest wording; the checks below flip one at a
			// time and assert that only that one wording degrades.
			get(name) {
				if (name === 'create_ui_block') return installed.create_ui_block ? {} : undefined;
				if (name === 'spawn_teammate') return installed.spawn_teammate ? {} : undefined;
				return undefined;
			}
		},
		commands: {
			register(definition) {
				captured.commands.push(definition);
			}
		},
		settings: settingsService,
		agents: { get: (id) => captured.agents.get(id) },
		webServer: {
			register(route) {
				captured.routes.push(route);
				return () => {};
			}
		},
		// cordis effect() runs the callback inside the plugin fiber and keeps its
		// disposer; the routes exist only because the callback ran, so this stub
		// must CALL it — a no-op effect would report zero routes and look like a
		// wiring bug.
		effect(fn) {
			captured.effects += 1;
			return fn();
		}
	};
	const ctx = {
		inject(names, callback) {
			if (captured.injectedWith === undefined) captured.injectedWith = [...names];
			captured.injects.push([...names]);
			callback(host);
		},
		// Two things `apply()` itself needs since the preset derivation: the service
		// it declares in `apply.inject`, and `effect` for the registration disposer.
		// This `effect` deliberately does NOT touch `captured.effects`: that counter
		// is asserted to be exactly the two bridge groups below.
		agentPresets: { register: async () => async () => {} },
		effect(fn) {
			fn();
		}
	};
	return { ctx, captured, logged, host };
}

/** A fake session folding events through the registered projection. */
function makeSession(captured, id) {
	const projected = new Map();
	// The turnBoundary projection both mode halves read to decide pending vs commit.
	projected.set('turnBoundary', { openTurnStartSeq: null, lastTurn: 0 });
	for (const definition of captured.projections.values()) {
		if (!projected.has(definition.key)) projected.set(definition.key, definition.init());
	}
	const session = {
		id,
		projected,
		appended: [],
		append(type, data) {
			session.appended.push({ type, data });
			for (const definition of captured.projections.values()) {
				const current = projected.get(definition.key) ?? definition.init();
				projected.set(definition.key, definition.apply(current, { type, data }));
			}
		}
	};
	return session;
}

/** A fake agent over a session. */
function makeAgent(session) {
	const injected = [];
	const steered = [];
	return {
		session,
		inbox: {
			nextStep: [],
			removed: [],
			remove(id) {
				this.removed.push(id);
				this.nextStep = this.nextStep.filter((message) => message.id !== id);
			}
		},
		injected,
		steered,
		inject(message) {
			injected.push(message);
		},
		steer(message) {
			steered.push(message);
		}
	};
}

/**
 * Drive one bridge route the way the webserver does, and read its JSON body.
 * req is a real Readable so both body styles a handler may use (async iteration
 * and on('data')) see the same bytes — a hand-rolled emitter covers only one.
 */
async function callRoute(route, options = {}) {
	const { body, method = 'POST', remoteAddress = '127.0.0.1', host = '127.0.0.1:3080' } = options;
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	const req = Readable.from(chunks, { objectMode: false });
	req.method = method;
	req.socket = { remoteAddress };
	req.headers = {
		host,
		'content-type': 'application/json',
		'content-length': String(chunks.length === 0 ? 0 : chunks[0].length)
	};
	let status = 0;
	let payload = '';
	const res = {
		writeHead(code) {
			status = code;
		},
		setHeader() {},
		end(text) {
			payload = text === undefined ? '' : String(text);
		}
	};
	await route.handler(req, res);
	return { status, body: payload === '' ? undefined : JSON.parse(payload) };
}

// --- mount ------------------------------------------------------------------
// The settings shim mounts a namespace; this stub only has to answer the two
// questions installGateSection asks (describe + installSection) so the mount
// takes the modern branch and its .then() logs instead of warning.
function makeApplySettings() {
	const applied = [];
	return {
		applied,
		service: {
			installSection(_owner, ns, schema, entry, hooks) {
				applied.push({ ns, entry });
				hooks.setSource(() => schema(entry));
				hooks.onChange();
			},
			describe: () => [{ ns: GATE_SETTINGS_NS, value: { ...GATE_DEFAULTS } }]
		}
	};
}

const applySettings = makeApplySettings();
const { ctx, captured, logged } = makeContext(applySettings.service);
const { apply } = await import('./lib/index.js');
const savedArgv = process.argv.slice();
if (typeof hostBin === 'string') process.argv = ['node', hostBin, 'web'];
try {
	// `backend: 'jev'` is the fixture, not the default: the trail block below stubs
	// the JEV endpoint and asserts ITS numbers, so the mount names the backend it
	// exercises instead of following whatever the shipped default becomes.
	await apply(ctx, { gate: { enabled: true, backend: 'jev' } });
} finally {
	process.argv = savedArgv;
}

// --- the merge's registration surface (§6.3) ---------------------------------
same(captured.injects, [
	['llm', 'systemPrompt', 'sessionProjections', 'tools', 'subagents'],
	['settings'],
	['webServer', 'agents'],
	['webServer', 'settings']
], 'the four inject groups are exactly the documented ones');
same(captured.injectedWith, ['llm', 'systemPrompt', 'sessionProjections', 'tools', 'subagents'], 'the mode wiring owns the first inject');

eq(captured.projections.has('mode'), true, 'the merged plugin registers the mode projection');
eq(captured.projections.has('cursorPlan'), false, 'the legacy cursorPlan projection is gone');
const modeDefinition = captured.projections.get('mode');
eq(modeDefinition?.key, MODE_KEY, 'the projection key is the module constant');
eq(modeDefinition?.stateVersion, 4, 'the mode projection is stateVersion 4');
// The fake session replays init()/apply(), so the two shapes it depends on are
// pinned here: init() is the full latch state a session starts from, and the
// VIEW is the two-field read the client uses. Folding the view instead of the
// state would make every mode check below pass against the wrong object.
same(modeDefinition?.init(), {
	plan: false,
	multi: false,
	mode: 'default',
	modeAtHeader: 'default',
	wanted: null,
	running: null
}, 'modeInit() is the latch state a session starts from');
same(
	modeDefinition?.wire?.view({ plan: true, multi: false, mode: 'plan', modeAtHeader: 'plan', wanted: true, running: null }),
	{ mode: 'plan', pending: true },
	'modeView() is exactly { mode, pending }'
);

const sectionOf = (name) => captured.sections.find((entry) => entry.name === name);
const planSection = sectionOf('cursorPlan:policy');
const multiSection = sectionOf('mode:policy');
eq(captured.sections.length, 2, 'exactly two policy sections register (one per mode owner)');
eq(multiSection?.order, 501, 'mode:policy sits at 501');
eq(planSection?.order, 502, 'cursorPlan:policy sits at 502, past plan:policy (500) and before team:policy (600)');
ok(501 < 502 && 502 < 600, 'the two orders bracket the official plan section without colliding');

// 2026-10-23: both mode commands were deleted. The mode control's bridge plus
// agent/pre-step is the only way in, so a command appearing here again is the
// regression this pins.
eq(captured.commands.length, 0, 'no mode command registers at all');

eq(captured.tools.length, 3, 'three tools register');
const toolOf = (name) => captured.tools.find((entry) => entry.name === name);
const planTool = toolOf('create_plan');
const quotaTool = toolOf('request_more_edits');
same(captured.tools.map((entry) => entry.name).sort(), ['create_plan', 'list_running_agent', 'request_more_edits'], 'the three model-facing tools, and no fourth');

// --- one handler per hook (§5.4a), plus the 0.2.1 todos handover ------------
//
// 0.2.1 merged `dsh-subagent-todos` 0.1.0 into this package, so the surface is
// six keys and NOT four. The two shared events keep exactly the two handlers
// the merge documents: the modes' own (registered first, so outermost) and the
// handover's (idempotent re-patch / `next()` unwrapped), which cannot change
// the decision either way. `tools/change` and `agent/created` are the
// handover's alone - nothing else in this package listens to them.
const counts = Object.fromEntries([...captured.handlers].map(([key, list]) => [key, list.length]));
same(Object.keys(counts).sort(), [
	'agent/created',
	'agent/inbox/claimed',
	'agent/pre-step',
	'tools/change',
	'tools/post-execute',
	'tools/pre-execute'
], 'exactly six hook keys, no stragglers: ' + show(Object.keys(counts).sort()));
eq(counts['agent/pre-step'], 2, 'two agent/pre-step: the modes (outermost) + the todos re-patch');
eq(counts['tools/post-execute'], 2, 'two tools/post-execute: the modes (outermost) + the todos claim');
eq(counts['tools/change'], 1, 'one tools/change - the hook that puts todos on the step-1 schema');
eq(counts['agent/created'], 1, 'one agent/created - the latch armed at creation');
eq(counts['agent/inbox/claimed'], 1, 'one agent/inbox/claimed (the multi wake observer)');
ok(counts['agent/inbox/inserted'] === undefined, 'no agent/inbox/inserted: the commit lives in agent/pre-step now');
const preExecute = captured.handlers.get('tools/pre-execute');
eq(preExecute?.length, 1, '§5.4(a) exactly ONE tools/pre-execute — the merged gate runs both branches internally');
const preExecuteHandler = preExecute[0];
const preStep = captured.handlers.get('agent/pre-step')[0];
const postExecute = captured.handlers.get('tools/post-execute')[0];

/**
 * Switch a session the way the composer's mode control does: POST the choice to
 * the /stage bridge, then run the next step with a claimed user message — the
 * only step a staged selection may land on (口径 S1).
 *
 * @param {object} targetAgent
 * @param {string} target
 * @param {object} [message]
 * @returns {Promise<object>} the decision the pre-step handed back
 */
async function postStage(sessionId, target) {
	const stage = captured.routes.find((route) => route.path === '/api/dsh-cursor-modes/switch/stage');
	if (stage === undefined) throw new Error('the switch bridge is not mounted');
	const req = Readable.from([Buffer.from(JSON.stringify({ sessionId, target }))]);
	req.method = 'POST';
	req.socket = { remoteAddress: '127.0.0.1' };
	req.headers = { host: '127.0.0.1:4000', 'content-type': 'application/json' };
	let body;
	await stage.handler(req, { writeHead() {}, setHeader() {}, end(text) { body = JSON.parse(text); } });
	eq(body?.ok, true, 'the switch bridge accepted ' + target + ' for ' + sessionId);
	return body;
}
async function switchTo(targetAgent, target, message = { role: 'user', source: { kind: 'user' } }) {
	await postStage(targetAgent.session.id, target);
	return preStep({ agent: targetAgent, signal: { aborted: false } }, async () => ({ kind: 'allow', messages: [message] }));
}

eq(captured.effects, 2, 'both bridge groups mount through effect()');
eq(captured.routes.length, 9, 'nine HTTP routes register (build + plan-state + 4 switch + 3 settings card)');
ok(captured.routes.every((route) => route.kind === 'exact'), 'exact paths only');
ok(captured.routes.every((route) => String(route.path).startsWith('/api/dsh-cursor-modes/')), 'every route is under the merged prefix');
eq(new Set(captured.routes.map((route) => route.path)).size, 9, 'nine distinct paths');

// --- create_plan schema survives real defineTool validation ------------------
eq(planTool?.parameters?.type, 'object', 'create_plan parameters are an object schema');
same(planTool?.parameters?.required, ['plan'], 'only the plan field is required');
same(Object.keys(planTool?.parameters?.properties ?? {}).sort(), ['name', 'overview', 'plan', 'todos'], 'the four parameters, sorted');
eq(planTool?.parameters?.properties?.todos?.type, 'array', 'todos is an array');
same(
	(planTool?.parameters?.properties?.todos?.items?.required ?? []).slice().sort(),
	['content', 'id', 'status'],
	'each todo requires content, id and status'
);
same(
	planTool?.parameters?.properties?.todos?.items?.properties?.status?.enum,
	['pending', 'in_progress', 'completed', 'cancelled'],
	'the todo status enum is the shipped four'
);
ok(String(planTool?.description ?? '').startsWith('Use this tool to create a concise plan'), 'the shipped description is verbatim');
eq(planTool?.output?.schema?.type, 'object', 'the output schema is an object');
eq(planTool?.output?.schema?.additionalProperties, false, 'the output schema is closed');
same(Object.keys(planTool?.output?.schema?.properties ?? {}).sort(), ['path', 'title', 'todos'], 'the output carries path, title and the checklist');
eq(planTool?.output?.schema?.properties?.path?.type, 'string', 'path is a string');
ok((planTool?.output?.schema?.required ?? []).includes('path'), 'path is required on output');
ok((planTool?.output?.schema?.required ?? []).includes('title'), 'title is required on output');
// The checklist leaves the tool with the plan: it used to be dropped here, which
// is how the card and the Build bridge lost the very list the model wrote.
eq(planTool?.output?.schema?.properties?.todos?.type, 'array', 'the output carries the checklist as an array');
ok((planTool?.output?.schema?.required ?? []).includes('todos'), 'todos is required on output, so a plan without one still answers []');
same(
	(planTool?.output?.schema?.properties?.todos?.items?.required ?? []).slice().sort(),
	['content', 'id', 'status'],
	'the returned todo keeps the id the plan declared'
);
eq(
	planTool?.output?.schema?.properties?.todos?.items?.additionalProperties,
	false,
	'the returned todo is closed, so no extra key rides along'
);

// --- the constant: one text for every mode, on every request -----------------
// 2026-10-29 (stable prefix): the section no longer varies with the mode. That is
// the property a switch survives the provider's prompt cache on, and it is asserted
// first; the marker block further down proves the mode still reaches the model.
const session = makeSession(captured, 's1');
const agent = makeAgent(session);
const allowed = { kind: 'allow' };
const next = async () => allowed;
eq(planSection?.text({ agent }), MODE_RULES, 'default mode already renders the whole constant: no empty state is left');

const enter = await switchTo(agent, 'plan');
same(session.appended, [{ type: MODE_RECORD, data: { mode: 'plan' } }], 'entering appends ONE plugin:cursormodes/state record, not the legacy pair');
const enterTexts = (enter.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text).join(''));
eq(enterTexts.length, 2, 'the entry step carries the user message and one switch notice');
eq(enterTexts[1], 'The user switched this session to plan mode.', 'the notice says which mode it entered');
eq(planSection?.text({ agent }), MODE_RULES, 'plan mode renders the same constant, not a plan-only set');
// A request header makes the mode "told". The bytes must not move for that either:
// a header-dependent section is how the second request of a session used to miss.
session.append('request/header', { reason: 'change' });
eq(planSection?.text({ agent }), MODE_RULES, 'after a header -> the same section, byte for byte');

// --- the exemption paragraph adapts to whether create_ui_block is installed --
// A deployment without the ui-block plugin must not be pointed at a tool it
// cannot call, so the paragraph loses exactly that half-sentence and nothing else.
installed.create_ui_block = false;
const bareSession = makeSession(captured, 's-bare');
const bareAgent = makeAgent(bareSession);
await switchTo(bareAgent, 'plan');
const bareEntry = planSection?.text({ agent: bareAgent });
eq(bareEntry, MODE_RULES.replace(UI_BLOCK_SENTENCE, UI_BLOCK_SENTENCE_WITHOUT_TOOL), 'no create_ui_block -> the tool-free constant');
ok(typeof bareEntry === 'string' && !bareEntry.includes('create_ui_block'), 'the absent tool is never named');
bareSession.append('request/header', { reason: 'change' });
const bareContinue = planSection?.text({ agent: bareAgent });
eq(bareContinue, MODE_RULES.replace(UI_BLOCK_SENTENCE, UI_BLOCK_SENTENCE_WITHOUT_TOOL), 'no create_ui_block -> the tool-free constant, and still the same after a header');
ok(typeof bareContinue === 'string' && !bareContinue.includes('create_ui_block'), 'the absent tool is never named here either');
installed.create_ui_block = true;

// --- multi: the second policy section renders nothing, in every mode ---------
// The multitask wording moved into the constant, so this slot must stay EMPTY: two
// sections answering the same constant would print the rules twice.
const teamSession = makeSession(captured, 's-team');
const teamAgent = makeAgent(teamSession);
eq(multiSection?.text({ agent: teamAgent }), '', 'the second policy section is empty outside multi mode');
const enterMulti = await switchTo(teamAgent, 'multi');
same(teamSession.appended, [{ type: MODE_RECORD, data: { mode: 'multi' } }], 'entering multi appends the same plugin record');
matches((enterMulti.messages ?? []).at(-1)?.content?.[0]?.text, /The user switched this session to multitask mode\./, 'entering multi carries the switch notice');
eq(multiSection?.text({ agent: teamAgent }), '', 'and still empty inside multi mode: the rules are rendered once, by the constant');
installed.spawn_teammate = true;
eq(multiSection?.text({ agent: teamAgent }), '', 'a mounted spawn_teammate changes nothing here either: its text lives in the constant, not this slot');
installed.spawn_teammate = false;
ok(MODE_RULES.includes('NEVER await or sleep'), 'the multitask rules moved into the constant verbatim');
ok(!MODE_RULES.includes('spawn_teammate'), 'the Agent Teams tails stay a deployment variant, never part of the constant');

// --- the mode marker: a runtime context, and the only moving part ------------
// (a) the section is byte-identical across modes, (b) the marker is not, and
// (c) the two live in different registries, so a switch cannot touch the section.
const contextOf = (name) => captured.contexts.find((entry) => entry.name === name);
const modeContext = contextOf('cursor-modes:mode');
ok(modeContext !== undefined, 'the mode marker registers as a runtime context');
eq(modeContext?.order, 220, 'the marker sits last in the runtime-context snapshot (after web surface 210)');
eq(modeContext?.interpolate, false, 'the marker is literal text, so a prompt variable can never rewrite it');
eq(captured.sections.some((entry) => entry.name === 'cursor-modes:mode'), false, 'the marker is NOT a section: a section would live in the cached prefix');
eq(captured.contexts.length, 1, 'exactly one context registers — the mode marker — so it cannot drift into a second copy');

const markDefaultSession = makeSession(captured, 's-marker-default');
const markDefaultAgent = makeAgent(markDefaultSession);
const markPlanSession = makeSession(captured, 's-marker-plan');
const markPlanAgent = makeAgent(markPlanSession);
const markMultiSession = makeSession(captured, 's-marker-multi');
const markMultiAgent = makeAgent(markMultiSession);
markPlanSession.append(MODE_EVENT, { mode: 'plan' });
await switchTo(markMultiAgent, 'multi');

// (a) same bytes in default and plan
eq(planSection.text({ agent: markDefaultAgent }), planSection.text({ agent: markPlanAgent }), '(a) the section renders byte-identical text in default and plan');
eq(planSection.text({ agent: markDefaultAgent }), MODE_RULES, '(a) ... and those bytes are the constant itself, not a copy');
eq(planSection.text({ agent: markMultiAgent }), planSection.text({ agent: markPlanAgent }), '(a) plan and multitask render the same bytes too');

// (b) the marker follows the mode and names it
eq(modeContext.text({ agent: markDefaultAgent }), '<当前模式>default</当前模式>', '(b) the marker names the default mode');
eq(modeContext.text({ agent: markPlanAgent }), '<当前模式>plan</当前模式>', '(b) and the plan mode');
eq(modeContext.text({ agent: markMultiAgent }), '<当前模式>multitask</当前模式>', '(b) and spells multi the way the rules do: multitask, not the persisted id');
eq(modeContext.text({}), '', '(b) a context with no agent renders nothing');
ok(modeContext.text({ agent: markPlanAgent }) !== modeContext.text({ agent: markDefaultAgent }), '(b) the marker is the one thing that changes with the mode');

// (c) the two registries are separate: a switch must not touch the section
const switchSession = makeSession(captured, 's-marker-switch');
const switchAgent = makeAgent(switchSession);
switchSession.append(MODE_EVENT, { mode: 'plan' });
const bytesInPlan = planSection.text({ agent: switchAgent });
const markerInPlan = modeContext.text({ agent: switchAgent });
await switchTo(switchAgent, 'multi');
eq(planSection.text({ agent: switchAgent }), bytesInPlan, '(c) switching plan -> multitask leaves the section byte-identical');
ok(modeContext.text({ agent: switchAgent }) !== markerInPlan, '(c) ... and moves only the marker');
eq(captured.sections.length, 2, '(c) the switch registered no section: the section registry is untouched');


// (d) the Agent Teams branch: what the host mounts selects the text -------------
// A host that mounts spawn_teammate gets the three tails spliced into the same
// constant; a host that does not (4000) must keep rendering the plain constant,
// byte for byte, or every 4000 request would carry team rules it cannot use.
const TEAM_ANCHORS = [
	'set to `true`.',
	'you will be notified when the subagent completes.',
	'not about maximizing the number of parallel agents.'
];
const TEAM_TAILS = [
	'When the user explicitly asks for Agent Teams',
	'This holds for teammates too',
	'not over-decomposition'
];
const countIn = (text, needle) => text.split(needle).length - 1;
const plain = planSection.text({ agent: markDefaultAgent });
for (const tail of TEAM_TAILS) eq(countIn(plain, tail), 0, '(d) without the mount the section never carries: ' + tail);
installed.spawn_teammate = true;
const teamText = planSection.text({ agent: markDefaultAgent });
eq(teamText, withTeamTails(MODE_RULES), '(d) with the mount the section is the shared reducer applied to the constant, not a hand-built variant');
eq(countIn(teamText, TEAM_TAILS[0]), 1, '(d) and the first tail is spliced once, not twice');
ok(teamText.length > plain.length, '(d) ... which is longer than the plain constant');
for (let i = 0; i < TEAM_ANCHORS.length; i += 1) {
	eq(countIn(teamText, TEAM_TAILS[i]), 1, '(d) each tail lands exactly once: ' + TEAM_TAILS[i]);
	ok(teamText.indexOf(TEAM_ANCHORS[i]) < teamText.indexOf(TEAM_TAILS[i]), '(d) each tail lands after its own anchor: ' + TEAM_TAILS[i]);
	eq(countIn(plain, TEAM_ANCHORS[i]), 1, '(d) the anchors are single occurrences in the constant, so one splice cannot land twice: ' + TEAM_ANCHORS[i]);
}
eq(planSection.text({ agent: markPlanAgent }), teamText, '(d) the team text does not vary with the mode');
eq(planSection.text({ agent: markDefaultAgent }), teamText, '(d) nor between two calls with the same mount, so the bytes stay stable per request');
installed.create_ui_block = false;
eq(planSection.text({ agent: markDefaultAgent }), teamText.replace(UI_BLOCK_SENTENCE, UI_BLOCK_SENTENCE_WITHOUT_TOOL), '(d) the tool-free wording still applies on top of the team variant');
installed.create_ui_block = true;
installed.spawn_teammate = false;
eq(planSection.text({ agent: markDefaultAgent }), MODE_RULES, '(d) and the plain constant comes back, byte for byte, when the mount is gone');

// --- §5.4(b): plan mode answers BEFORE a full multitask quota ---------------
// The one call both gates can see: a non-plan write made in plan mode while the
// agent's quota is ALREADY exhausted. If the two branches swapped, the multi
// gate would answer first and the refusal would be the quota sentence — so the
// assertions pin WHICH sentence came back, not merely that something denied.
// plan-mode never blocks reads, so the writes below are the only real subject.
const orderSession = makeSession(captured, 's-order');
const orderAgent = makeAgent(orderSession);
orderSession.append(MODE_EVENT, { mode: 'plan' });
eq(orderSession.projected.get(MODE_KEY)?.mode, 'plan', 'the fake session folds the plan mode out of the real projection');

eq(await preExecuteHandler({ name: 'pwsh', arguments: { command: 'rm -rf x' }, agent: orderAgent }, next), allowed, 'plan mode never blocks shell');
eq(
	await preExecuteHandler({ name: 'write', arguments: { file_path: 'D:\\x\\plan.md', content: 'x' }, agent: orderAgent }, next),
	allowed,
	'writing a markdown file is planning material'
);
eq(
	await preExecuteHandler({ name: 'str_replace_editor', arguments: { command: 'create', path: 'p.markdown', file_text: 'x' }, agent: orderAgent }, next),
	allowed,
	'str_replace_editor create on .markdown is allowed'
);
eq(await preExecuteHandler({ name: 'read', arguments: { file_path: 'a.py' }, agent: orderAgent }, next), allowed, 'read is never blocked');
eq(
	await preExecuteHandler({ name: 'str_replace_editor', arguments: { command: 'view', path: 'a.py' }, agent: orderAgent }, next),
	allowed,
	'str_replace_editor view is a read, not a mutation'
);
// An EXISTING .uiblock draft is planning material; only creating one is not.
const draftPath = join(process.env.DSH_HOME, 'ui-blocks', 'draft.uiblock');
mkdirSync(dirname(draftPath), { recursive: true });
writeFileSync(draftPath, '<div></div>', 'utf8');
eq(
	await preExecuteHandler({ name: 'edit', arguments: { file_path: draftPath, old_string: 'a', new_string: 'b' }, agent: orderAgent }, next),
	allowed,
	'revising an existing .uiblock draft is allowed in plan mode'
);

// Generated material under <DSH_HOME>/ui-captures is a product, not source, so plan
// mode lets write/edit touch it (2026-11-11). The boundary is the RESOLVED absolute
// path: a `..` escape into ui-blocks and a lookalike sibling both stay blocked, and a
// block is still rebuilt with create_ui_block rather than hand-edited.
const captures = join(process.env.DSH_HOME, 'ui-captures');
const captureFile = join(captures, 'pintia-exam', 'entry.html');
eq(
	await preExecuteHandler({ name: 'edit', arguments: { file_path: captureFile, old_string: 'a', new_string: 'b' }, agent: orderAgent }, next),
	allowed,
	'editing a generated capture under ui-captures is allowed in plan mode'
);
eq(
	await preExecuteHandler({ name: 'write', arguments: { file_path: captureFile.toUpperCase(), content: 'x' }, agent: orderAgent }, next),
	allowed,
	'... and the upper-case spelling is the same directory on Windows, so folding case opens no hole'
);
const demoDenied = await preExecuteHandler(
	{ name: 'edit', arguments: { file_path: join(process.env.DSH_HOME, 'ui-blocks', 'demo.uiblock'), old_string: 'a', new_string: 'b' }, agent: orderAgent },
	next
);
eq(demoDenied?.kind, 'deny', 'a block is still refused: it is rebuilt with create_ui_block, never hand-edited');
matches(demoDenied?.reason, /only planning material may be edited/, '... with the plan-mode sentence, unchanged');
matches(demoDenied?.reason, /~\/\.dsh\/ui-captures\//, '... which names the one new exemption, so the refusal stays accurate');
const escapeDenied = await preExecuteHandler(
	{ name: 'edit', arguments: { file_path: join(captures, '..', 'ui-blocks', 'x.uiblock'), old_string: 'a', new_string: 'b' }, agent: orderAgent },
	next
);
eq(escapeDenied?.kind, 'deny', 'ui-captures\\..\\ui-blocks\\x.uiblock resolves OUT of the exemption, so it is denied');
const siblingDenied = await preExecuteHandler(
	{ name: 'write', arguments: { file_path: join(process.env.DSH_HOME, 'ui-captures-x', 'a.html'), content: 'x' }, agent: orderAgent },
	next
);
eq(siblingDenied?.kind, 'deny', 'ui-captures-x is a sibling, not a child: the prefix must end on a separator');
const sourceDenied = await preExecuteHandler(
	{ name: 'write', arguments: { file_path: 'D:\\work\\src\\index.js', content: 'x' }, agent: orderAgent },
	next
);
eq(sourceDenied?.kind, 'deny', 'workspace source stays read-only: the exemption is a directory, not a mood');

const orderGate = gateOf(orderAgent);
eq(spentOf(orderGate), 0, 'the plan allow-side above never charged the multitask gate');
// Fill the window the way the gate itself counts: LIMIT distinct serial roots.
while (orderGate.seen.size < LIMIT) orderGate.seen.add('filler-' + orderGate.seen.size);
eq(spentOf(orderGate), LIMIT, 'the quota is filled to LIMIT (' + String(LIMIT) + ') before the plan call');
const spentBefore = spentOf(orderGate);
// notes.py is deliberately something plan mode refuses AND the quota gate would
// also refuse, so only the ORDER decides which sentence comes back.
const planDenied = await preExecuteHandler(
	{ name: 'write', arguments: { file_path: 'D:\\work\\notes.py', content: 'print(1)' }, agent: orderAgent },
	next
);
eq(planDenied?.kind, 'deny', '§5.4(b) mode=plan + a spent quota still denies a non-plan write');
ok(
	typeof planDenied?.reason === 'string' && !/tool-call gate/.test(planDenied.reason),
	'§5.4(b) the refusal is NOT the multitask quota sentence — this is the swap witness: ' + show(planDenied?.reason)
);
matches(planDenied?.reason, /plan/i, '§5.4(b) the refusal is the plan-mode sentence');
matches(planDenied?.reason, /notes\.py/, '§5.4(b) the refusal names the target it refused');
matches(planDenied?.reason, /Only the user can change the mode/, '§5.4(b) the refusal names the way out without naming a deleted command');
eq(spentOf(orderGate), spentBefore, '§5.4(b) a plan-mode refusal charges nothing: the quota gate never ran');
eq(orderGate.pendingNotice, undefined, '§5.4(b) no quota notice was latched, so post-execute cannot attach one');
const tsDenied = await preExecuteHandler({ name: 'edit', arguments: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, agent: orderAgent }, next);
eq(tsDenied?.kind, 'deny', '§5.4(b) editing a .ts file in plan mode is denied');
matches(tsDenied?.reason, /plan/i, '§5.4(b) ... with the plan sentence again');
eq(spentOf(orderGate), spentBefore, '§5.4(b) still nothing charged');

// --- §5.4(c): the reverse — in multi mode the quota sentence is the refusal --
const multiOrderSession = makeSession(captured, 's-order-multi');
const multiOrderAgent = makeAgent(multiOrderSession);
multiOrderSession.append(MODE_EVENT, { mode: 'multi' });
const multiOrderGate = gateOf(multiOrderAgent);
while (multiOrderGate.seen.size < LIMIT) multiOrderGate.seen.add('m-filler-' + multiOrderGate.seen.size);
const multiDenied = await preExecuteHandler({ name: 'edit', arguments: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, agent: multiOrderAgent }, next);
eq(multiDenied?.kind, 'deny', '§5.4(c) a spent quota in multi mode denies the edit');
matches(multiDenied?.reason, /tool-call gate/, '§5.4(c) ... with the multitask quota sentence, so the two gates stay distinguishable');

// --- the delegation gate's judgement trail ----------------------------------
// This is the only place the real pre-execute branch runs with the judge
// enabled, so the trail is asserted by DRIVING it, not by reading the source.
// Both sinks must carry the line: the host logger, and stderr — the sink a host
// log file captures, since this deployment registers no logger exporter.
const judgeCalls = [];
const stderrLogged = [];
const realConsoleError = console.error;
console.error = (...args) => stderrLogged.push(args);
const TRAIL_PREFIX = 'dsh-cursor-modes: delegation gate ';
const trailOf = () => logged.filter((args) => String(args[0]).startsWith(TRAIL_PREFIX));
const stderrTrailOf = () => stderrLogged.filter((args) => String(args[0]).startsWith(TRAIL_PREFIX));
const trailSession = makeSession(captured, 's-trail');
const trailAgent = makeAgent(trailSession);
trailSession.append(MODE_EVENT, { mode: 'plan' });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	judgeCalls.push(JSON.parse(init.body).state);
	return new Response(JSON.stringify({
		answers: { intent: { choice: 'read_only_research', confidence: 0.9 }, work: { noul: 0.1 } }
	}), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
	eq(
		await preExecuteHandler(
			{ name: 'subagent', arguments: { description: 'look', prompt: 'Read src/app.js and report what it does.' }, agent: trailAgent },
			next
		),
		allowed,
		'a confident read-only judgement lets the delegation through'
	);
} finally {
	globalThis.fetch = realFetch;
}
eq(judgeCalls.length, 1, 'the judge saw the task text once');
eq(judgeCalls[0], 'look\n\nRead src/app.js and report what it does.', 'description and prompt join into the judged payload');
eq(trailOf().length, 1, 'every judgement leaves exactly one host log line');
const trail = trailOf().length > 0 ? format(...trailOf()[0]) : '';
matches(trail, /allow=true/, 'the line carries the verdict');
matches(trail, /intent=read_only_research/, 'the line carries the judged intent');
matches(trail, /confidence=0\.9/, 'the line carries the confidence');
matches(trail, /change-probability=0\.1/, 'the line carries the change-probability');
eq(stderrTrailOf().length, 1, 'the same judgement reaches stderr exactly once');
eq(stderrTrailOf().length > 0 ? format(...stderrTrailOf()[0]) : undefined, trail, 'both sinks render the identical line');
// A branch with no audit — here an empty payload — logs its reason instead.
logged.length = 0;
stderrLogged.length = 0;
const unjudged = await preExecuteHandler({ name: 'subagent', arguments: {}, agent: trailAgent }, next);
eq(unjudged?.kind, 'deny', 'a delegation with no task text still fails closed');
eq(trailOf().length, 1, 'the unjudged branch also leaves one line');
matches(
	trailOf().length > 0 ? format(...trailOf()[0]) : '',
	/allow=false intent=n\/a confidence=n\/a change-probability=n\/a reason=nothing to judge/,
	'the no-audit line names the reason'
);
eq(stderrTrailOf().length, 1, 'the unjudged branch also reaches stderr');
eq(
	stderrTrailOf().length > 0 ? format(...stderrTrailOf()[0]) : undefined,
	trailOf().length > 0 ? format(...trailOf()[0]) : '',
	'both sinks agree on the no-audit line'
);
console.error = realConsoleError;

// --- tool execute + render ---------------------------------------------------
const result = await planTool.execute({ name: 'Add install docs', overview: 'Short.', plan: '# Add install docs\n\nDo it.\n' }, {});
ok(typeof result?.path === 'string' && result.path.endsWith('.plan.md'), 'the plan lands in a .plan.md: ' + show(result?.path));
eq(result?.title, 'Add install docs', 'the title is the first heading');
same(result?.todos, [], 'a plan with no checklist answers an empty list, not undefined');
ok(typeof result?.path === 'string' && result.path.startsWith(join(fakeHome, '.dsh', 'plans')), 'landed under the throwaway home, never the real ~/.dsh/plans');
ok(typeof result?.path === 'string' && existsSync(result.path), 'the plan file exists on disk');
const written = typeof result?.path === 'string' && existsSync(result.path) ? readFileSync(result.path, 'utf8') : '';
ok(written.startsWith('---\n'), 'frontmatter opens the file');
ok(written.includes('name: Add install docs'), 'the frontmatter carries the name');
ok(written.includes('overview: Short.'), 'the frontmatter carries the overview');
ok(written.includes('# Add install docs'), 'the body is present');
matches(result?.path, /add_install_docs_[0-9a-f]{8}\.plan\.md$/, 'slug + 8 hex');
const rendered = planTool.output.render({ name: 'Add install docs', overview: 'Short.', plan: '# Add install docs\n' }, result);
eq(rendered?.[0]?.type, 'text', 'the render is one text block');
ok(
	typeof rendered?.[0]?.text === 'string' && rendered[0].text.startsWith('Plan file: ' + result.path + '\n'),
	'the card scrapes this first line: ' + show(String(rendered?.[0]?.text ?? '').split('\n')[0])
);
// A plan WITH a checklist returns it whole, id included: the card renders it and
// the Build bridge writes it into the session on approval.
const planned = await planTool.execute({
	name: 'Checklist plan',
	plan: '# Checklist plan\n\n## 方案设计\n\n...\n',
	todos: [
		{ id: 'backup', content: 'back up the files', status: 'pending' },
		{ id: 'restart', content: 'restart the instance', status: 'pending' }
	]
}, {});
same(planned?.todos, [
	{ id: 'backup', content: 'back up the files', status: 'pending' },
	{ id: 'restart', content: 'restart the instance', status: 'pending' }
], 'the checklist the model passed comes back with the plan, ids intact');
// The frontmatter keeps the whole list too, so a reload still has it.
const plannedText = existsSync(planned.path) ? readFileSync(planned.path, 'utf8') : '';
ok(plannedText.includes('content: back up the files'), 'the plan file frontmatter carries the checklist');

// A plan with no # heading is refused, so a malformed plan never reaches disk.
await assert.rejects(async () => planTool.execute({ plan: 'no heading here' }, {}), /starting with a # heading/);
await assert.rejects(async () => planTool.execute({ plan: '   ' }, {}), /starting with a # heading/);
passed += 2;

// --- planDoc: the CALL's mount, before the turn's closing reply ---------------
const docSession = makeSession(captured, 's-doc');
const docAgent = makeAgent(docSession);
docSession.append(MODE_EVENT, { mode: 'plan' });
docSession.projected.set('turnBoundary', { openTurnStartSeq: null, lastTurn: 3 });
const revised = '# Add install docs\n\nRevised body.\n';
const beforeDoc = docSession.appended.length;
const postAccept = { kind: 'accept' };
// One simulated call: pre-execute stamps the window's t0, the tool changes the
// disk, post-execute decides what to mount.
const preDoc = (name, args) => preExecuteHandler(
	{ name, arguments: args, agent: docAgent },
	async () => postAccept
);
const postDoc = (name, args, value) => postExecute(
	{ name, arguments: args, agent: docAgent },
	{ isError: false, content: [], value },
	async () => postAccept
);
// Claim source A: create_plan's own return value names the file it wrote.
await preDoc('create_plan', {});
writeFileSync(result.path, revised, 'utf8');
await postDoc('create_plan', {}, { title: 'Add install docs', path: result.path, todos: [] });
eq(docSession.appended.length, beforeDoc + 1, 'the call that wrote the plan appends exactly one planDoc');
same(docSession.appended.at(-1), { type: PLAN_DOC_RECORD, data: { turn: 3, path: result.path, plan: revised } }, 'the planDoc is the plugin:cursormodes/plandoc record and carries turn, path and body');
// A second write in the SAME turn appends a second record: the client keeps one
// card per turn and shows the last record before the closing reply.
await preDoc('write', { file_path: result.path });
const revised2 = revised + 'Second pass.\n';
writeFileSync(result.path, revised2, 'utf8');
const writeDecision = await postDoc('write', { file_path: result.path, content: revised2 }, undefined);
eq(writeDecision, postAccept, 'post-execute hands the decision on untouched');
eq(docSession.appended.length, beforeDoc + 2, 'a second write in the same turn appends a second planDoc');
eq(docSession.appended.at(-1)?.data?.plan, revised2, 'the later record carries the later body');
// Non-plan markdown must not publish: only a *.plan.md is the plan document.
// The 3 ms gap is the real one: two tool calls are never in the same ms, and
// the window is stamped with Date.now()'s integer.
await new Promise((resolve) => setTimeout(resolve, 3));
await preDoc('write', { file_path: join(fakeHome, 'notes.md') });
writeFileSync(join(fakeHome, 'notes.md'), 'x', 'utf8');
await postDoc('write', { file_path: join(fakeHome, 'notes.md'), content: 'x' }, undefined);
eq(docSession.appended.length, beforeDoc + 2, 'notes.md publishes no planDoc');

// --- the Build bridge is the only build path --------------------------------
eq(planSection?.text({ agent }), MODE_RULES, 'still the same section before the build');

// --- the Build bridge: one message, no command, no mode logic ---------------
const buildSession = makeSession(captured, 's-build');
const buildAgent = makeAgent(buildSession);
captured.agents.set('s-build', buildAgent);
const buildRoute = captured.routes.find((route) => route.path === BUILD_PATH);
ok(buildRoute !== undefined, 'the build bridge is registered through the webServer effect');
eq(buildRoute?.kind, 'exact', 'the build bridge is one exact path');

const built = await callRoute(buildRoute, { body: { sessionId: 's-build', choice: 'multi' } });
eq(built.status, 200, 'a loopback POST naming a live session is accepted');
// No planFile in the body: nothing to stamp, so the reply says dispatched:false.
// The stamp itself is covered by self-check-policy (plan-state) and the card.
same(
	built.body,
	{ ok: true, value: { sessionId: 's-build', choice: 'multi', mode: BUILD_TARGETS.multi, dispatched: false } },
	'the response names the staged mode and reports that no plan file was stamped'
);
eq(buildAgent.steered.length, 1, 'a Build click steers exactly one message');
const builtMessage = buildAgent.steered[0];
eq(builtMessage?.role, 'user', 'user role is what the switch hook applies a staged mode at');
eq(builtMessage?.source?.kind, NOTICE_PLUGIN, 'stamped as this plugin, so a later sweep can recognise its own line');
eq(builtMessage?.source?.form, 'notice', 'and as a notice, not a command');
eq(builtMessage?.content?.[0]?.text, buildText('multi'), 'the model reads exactly the multi message');
matches(builtMessage?.content?.[0]?.text, /^The user clicked "Build in Multi"\./, 'the opening line names the button pressed');
matches(builtMessage?.content?.[0]?.text, /Implement the plan as specified/, 'the instruction survives the merge');
matches(builtMessage?.content?.[0]?.text, /do NOT edit the plan file itself/, 'the plan file is kept');
same(buildSession.appended, [], 'the build route appends no session event of its own');

const builtDefault = await callRoute(buildRoute, { body: { sessionId: 's-build', choice: 'default' } });
eq(builtDefault.body?.value?.mode, 'default', 'the default button stages default');
eq(buildAgent.steered.length, 2, 'the second click steers a second message');
matches(buildAgent.steered[1]?.content?.[0]?.text, /^The user clicked "Build in Default"\./, 'the other button says the other thing');
ok(buildText('default') !== buildText('multi'), 'the two buttons say different things');

// Refusals steer nothing: an unknown choice, a session with no live agent, and a
// request from another origin or another verb.
eq((await callRoute(buildRoute, { body: { sessionId: 's-build', choice: 'sideways' } })).body?.code, 'unknown-choice', 'an unknown choice is refused');
const gone = await callRoute(buildRoute, { body: { sessionId: 'nobody', choice: 'default' } });
eq(gone.status, 409, 'a session with no live agent is 409');
eq(gone.body?.code, 'session-not-live', 'and names that reason');
eq((await callRoute(buildRoute, { remoteAddress: '10.0.0.5' })).status, 403, 'another origin is refused');
eq((await callRoute(buildRoute, { host: 'evil.example:3080' })).status, 403, 'another host header is refused');
eq((await callRoute(buildRoute, { method: 'GET' })).status, 405, 'another verb is refused');
eq((await callRoute(buildRoute)).status, 400, 'a missing body is refused');
eq(buildAgent.steered.length, 2, 'only a loopback POST naming a live session steers');

// --- the approved checklist: default build writes it, multi writes none ------
// (2026-10-24) A Build click lands while the session is idle, and the message it
// steers opens the next turn — whose `turn/start` clears the kernel's `todos`
// projection in the same breath. So this route may never append it: a default
// build STAGES the list and the one pre-step writes it inside that turn, while a
// multi build keeps it in the card alone (the workers get their own slices
// through `subagent`'s `todos` argument).
const todoSession = makeSession(captured, 's-build-todos');
const todoAgent = makeAgent(todoSession);
captured.agents.set('s-build-todos', todoAgent);
const checkedBuild = await callRoute(buildRoute, { body: {
	sessionId: 's-build-todos',
	choice: 'default',
	todos: [
		{ id: 'a', content: '  back up  ', status: 'completed' },
		{ id: 'b', content: 'run the checks', status: 'in_progress' },
		{ id: 'c', content: 'restart', status: 'pending' },
		{ id: 'd', content: 'dropped', status: 'cancelled' }
	]
} });
eq(checkedBuild.status, 200, 'a default build carrying a checklist is accepted');
same(todoSession.appended, [],
	'a default build appends nothing while the session is idle: that is the write turn/start used to wipe');
eq(todoAgent.steered.length, 1, 'and still steers the one build message');

/** One step the way the loop runs it: this turn's `turn/start`, then the pre-step. */
const enterStep = async (target, turn) => {
	target.session.append('turn/start', { turn });
	return preStep({ agent: target, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [] }));
};
const firstTurn = await enterStep(todoAgent, 1);
same(todoSession.appended, [
	{ type: 'turn/start', data: { turn: 1 } },
	{ type: 'todo/write', data: { todos: [
		{ content: 'back up', status: 'completed' },
		{ content: 'run the checks', status: 'in_progress' },
		{ content: 'restart', status: 'pending' }
	] } }
], 'ONE todo/write, AFTER turn/start, inside the turn the click opened: id dropped, trimmed, cancelled skipped');
const secondTurn = await enterStep(todoAgent, 2);
eq(todoSession.appended.filter((event) => event.type === 'todo/write').length, 1,
	'exactly one write per click: the staged list is deleted on sight, never replayed');
eq(todoSession.appended.at(-1)?.type, 'turn/start',
	'the NEXT turn is not re-seeded: per-turn clearing stays the kernel\'s');

// The checklist reaches the MODEL once, as the turn's opening context — never as
// a live mirror of the projection. Re-rendering it every step is exactly what a
// runtime-context section would do, and it would append a snapshot per edit.
const checklistIn = (decision) => (decision?.messages ?? []).filter((message) => JSON.stringify(message).includes('Todo from the plan:'));
eq(checklistIn(firstTurn).length, 1, 'the approved checklist reaches the model exactly once, on the turn the click opened');
ok(JSON.stringify(checklistIn(firstTurn)[0]).includes('[x] back up · [>] run the checks · [ ] restart'), '... naming every kept item and its status, with the cancelled one dropped');
eq(checklistIn(secondTurn).length, 0, '... and never again: the next turn runs as a normal session with no re-injection');

// "Build in Multi" writes no checklist at all: the workers own the work, and a
// list in this conversation would describe work nobody here is doing.
const multiTodoSession = makeSession(captured, 's-build-multi-todos');
const multiTodoAgent = makeAgent(multiTodoSession);
captured.agents.set('s-build-multi-todos', multiTodoAgent);
eq((await callRoute(buildRoute, { body: {
	sessionId: 's-build-multi-todos',
	choice: 'multi',
	todos: [{ id: 'a', content: 'delegate this', status: 'pending' }]
} })).status, 200, 'a multi build carrying a checklist is accepted');
eq(multiTodoAgent.steered.length, 1, 'the multi click still steers its one message');
await enterStep(multiTodoAgent, 1);
same(multiTodoSession.appended, [{ type: 'turn/start', data: { turn: 1 } }],
	'a multi build writes NO todo/write, not even inside the turn: this conversation gets no dock');

// Two clicks before that step runs replace each other: one entry per session, so
// a default build can never stack two lists.
const twiceSession = makeSession(captured, 's-build-twice');
const twiceAgent = makeAgent(twiceSession);
captured.agents.set('s-build-twice', twiceAgent);
await callRoute(buildRoute, { body: { sessionId: 's-build-twice', choice: 'default', todos: [{ id: 'a', content: 'first', status: 'pending' }] } });
await callRoute(buildRoute, { body: { sessionId: 's-build-twice', choice: 'default', todos: [{ id: 'b', content: 'second', status: 'pending' }] } });
await enterStep(twiceAgent, 1);
await enterStep(twiceAgent, 2);
eq(twiceSession.appended.filter((event) => event.type === 'todo/write').length, 1,
	'two clicks before the step runs write ONE list, never two');
same(twiceSession.appended.find((event) => event.type === 'todo/write')?.data?.todos,
	[{ content: 'second', status: 'pending' }], 'the newer click wins: the staging is overwritten, not appended to');

// A rejected step keeps the staging for the next one, the rule `state.pending` follows (I1).
const rejectedSession = makeSession(captured, 's-build-rejected');
const rejectedAgent = makeAgent(rejectedSession);
captured.agents.set('s-build-rejected', rejectedAgent);
await callRoute(buildRoute, { body: { sessionId: 's-build-rejected', choice: 'default', todos: [{ id: 'a', content: 'kept', status: 'pending' }] } });
await preStep({ agent: rejectedAgent, signal: { aborted: false } }, async () => ({ kind: 'reject', reason: 'archived' }));
same(rejectedSession.appended, [], 'a rejected step writes no checklist');
await enterStep(rejectedAgent, 1);
same(rejectedSession.appended.filter((event) => event.type === 'todo/write').map((event) => event.data.todos),
	[[{ content: 'kept', status: 'pending' }]], 'the list survives the rejection and lands in the step that enters');

// Order, so a reintroduced click-time append cannot hide behind the steer: the
// click leaves the message alone, whichever button was pressed.
for (const choice of ['default', 'multi']) {
	const orderLog = [];
	captured.agents.set('s-build-order-' + choice, {
		session: { id: 's-build-order-' + choice, append: (type) => orderLog.push('append:' + type) },
		steer: () => orderLog.push('steer')
	});
	await callRoute(buildRoute, { body: { sessionId: 's-build-order-' + choice, choice, todos: [{ id: 'a', content: 'step', status: 'pending' }] } });
	same(orderLog, ['steer'], 'a ' + choice + ' click steers the message and appends nothing');
}
// A build without a checklist writes nothing: a simple plan has none.
const noTodoSession = makeSession(captured, 's-build-plain');
captured.agents.set('s-build-plain', makeAgent(noTodoSession));
eq((await callRoute(buildRoute, { body: { sessionId: 's-build-plain', choice: 'multi' } })).status, 200, 'a build without a checklist is still accepted');
same(noTodoSession.appended, [], 'and appends no event of its own');
eq((await callRoute(buildRoute, { body: { sessionId: 's-build-plain', choice: 'multi', todos: [] } })).status, 200, 'an empty array is the same as absent');
same(noTodoSession.appended, [], 'the empty array writes nothing either');
// A malformed list is refused before the agent is looked up, so a half-written
// list can never reach the session.
for (const [label, todos] of [
	['not an array', 'nope'],
	['blank content', [{ content: '   ', status: 'pending' }]],
	['unknown status', [{ content: 'x', status: 'done' }]],
	['null item', [null]]
]) {
	const refused = await callRoute(buildRoute, { body: { sessionId: 's-build-plain', choice: 'multi', todos } });
	eq(refused.status, 400, 'a malformed checklist is refused: ' + label);
	eq(refused.body?.code, 'malformed-todos', 'and names the field: ' + label);
}
same(noTodoSession.appended, [], 'no refused build wrote a checklist');

// --- stale notice withdrawal -------------------------------------------------
// The one switch notice rides the step's own messages, so a switch injects
// nothing. The sweep stays wired for a line an older revision left pending: it
// may only remove THIS plugin's own kinds, never a foreign plugin's.
agent.inbox.nextStep.push({ id: 'stale-1', source: { kind: 'cursor-plan', form: 'notice', summary: 'The user switched this session to plan mode.' } });
agent.inbox.nextStep.push({ id: 'other-1', source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice' } });
const swept = await switchTo(agent, 'multi');
eq(agent.injected.length, 0, 'a switch injects nothing: the notice rides the step');
// TEETH: the sweep is keyed by message id, so the fake inbox records the ids it
// was asked to withdraw. Passing the CATEGORY ('plan'/'switch'/'quota') instead
// of message.id shows up here as ['plan'] — a removal that never happened.
same(agent.inbox.removed, ['stale-1'], 'only this plugin stale notice is withdrawn');
same(agent.inbox.nextStep, [{ id: 'other-1', source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice' } }], 'a foreign notice is left alone');
matches((swept.messages ?? []).at(-1)?.content?.[0]?.text, /from plan mode to multitask mode/, 'the cross-mode notice names the origin it left');

// --- S1 at the step boundary: only the user's own message lands it ----------
// The regression this pins is the retired behaviour, where any wake (a goal, a
// schedule, a stray steer) could consume the staged choice.
session.projected.set('turnBoundary', { openTurnStartSeq: 7, lastTurn: 1 });
await postStage('s1', 'plan');
eq(session.projected.get(MODE_KEY)?.mode, 'multi', 'a staged switch does not commit before a step runs');
await preStep({ agent, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'schedule' } }] }));
eq(session.projected.get(MODE_KEY)?.mode, 'multi', 'a step that claimed no user message leaves the selection pending');
const landed = await preStep({ agent, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' } }] }));
eq(session.projected.get(MODE_KEY)?.mode, 'plan', 'the step that claims the user message commits it');
eq((landed.messages ?? []).at(-1)?.source?.summary, 'dsh-cursor-modes: switched to plan mode', 'and carries the one-line summary the GUI can show');
session.projected.set('turnBoundary', { openTurnStartSeq: null, lastTurn: 1 });

// --- request_more_edits drives the real quota gate --------------------------
// defineTool() normalizes the shorthand into a JSON schema, so the assertion is
// on the normalized shape — the same surface the model is shown.
same(Object.keys(quotaTool?.parameters?.properties ?? {}), ['reason'], 'the tool takes exactly one argument');
eq(quotaTool?.parameters?.properties?.reason?.type, 'string', 'and it is a string');
same(quotaTool?.parameters?.required, ['reason'], 'and it is required');
same(
	Object.keys(quotaTool?.output?.schema?.properties ?? {}).sort(),
	['extra', 'granted', 'note', 'quota', 'spent'],
	'the answer carries the whole four-way verdict plus the usage'
);
const quotaSession = makeSession(captured, 's-quota');
const quotaAgent = makeAgent(quotaSession);
const notMulti = await quotaTool.execute({ reason: 'because' }, { agent: quotaAgent });
eq(notMulti?.granted, false, 'outside multi mode the tool grants nothing');
eq(notMulti?.note, 'not-multi', 'and says why');
quotaSession.append(MODE_EVENT, { mode: 'multi' });
const notSpent = await quotaTool.execute({ reason: 'because' }, { agent: quotaAgent });
eq(notSpent?.note, 'quota-not-spent', 'a window with quota left refuses the request');
const quotaGate = gateOf(quotaAgent);
while (quotaGate.seen.size < quotaOf(quotaGate)) quotaGate.seen.add('q-' + quotaGate.seen.size);
eq(spentOf(quotaGate), quotaOf(quotaGate), 'the window is spent before a grant can happen');
const blank = await quotaTool.execute({ reason: '   ' }, { agent: quotaAgent });
eq(blank?.note, 'blank-reason', 'a blank reason buys nothing');
const granted = await quotaTool.execute({ reason: 'I will finish the migration myself' }, { agent: quotaAgent });
eq(granted?.granted, true, 'a spent window with a real reason grants');
eq(granted?.extra, GRANT, 'the grant is the module GRANT, not a literal here');
eq(quotaOf(quotaGate), LIMIT + GRANT, 'and the window really grew');
matches(quotaTool.output.render({}, granted)?.[0]?.text, /Granted/, 'the render says it was granted');

// --- settings namespace + bridge against stub services ----------------------
eq(GATE_SETTINGS_NS, 'cursor-modes', 'the settings namespace is the MERGED plugin id, not the retired cursor-plan');

/** Minimal settings provider: one namespace, a composition base, a user layer. */
function makeSettingsStub(base) {
	const state = { resolved: null, section: {}, updates: [] };
	const service = {
		installSection(_owner, ns, schema, entry, hooks) {
			state.ns = ns;
			state.schema = schema;
			state.entry = entry;
			state.resolved = schema(entry);
			hooks.setSource(() => state.resolved);
			hooks.onChange();
		},
		describe: () => [{ ns: GATE_SETTINGS_NS, value: state.resolved }],
		async update(ns, patch) {
			state.updates.push({ ns, patch });
			state.section = { ...state.section, ...patch };
			state.resolved = state.schema({ ...state.entry, ...state.section });
		}
	};
	return { service, state };
}

const baseGate = { ...GATE_DEFAULTS, enabled: true, timeoutMs: 4000 };
const { service, state } = makeSettingsStub(baseGate);
let live = () => baseGate;
eq(
	await installGateSection({}, service, baseGate, {
		setSource: (source) => {
			live = () => ({ ...baseGate, ...(source() ?? {}) });
		},
		onChange: () => {}
	}),
	'installSection',
	'this harness answers the modern installSection API'
);
eq(state.ns, GATE_SETTINGS_NS, 'the namespace is the card key');
same(live(), baseGate, 'the composed config is the base layer');

const verdicts = { last: null };
const routes = makeGateRoutes(service, {
	gate: () => live(),
	verdicts,
	credential: async () => ({ ref: live().apiKeyRef, configured: false })
});
const routeOf = (path) => routes.find((route) => route.path === path);
same(routes.map((route) => route.path), [
	GATE_BRIDGE_PREFIX + '/describe',
	GATE_BRIDGE_PREFIX + '/mutate',
	GATE_BRIDGE_PREFIX + '/status'
], 'the card speaks three exact paths');
ok(routes.every((route) => route.kind === 'exact'), 'exact paths only');

const described = await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/describe'));
eq(described.status, 200, 'describe answers');
eq(described.body?.ok, true, 'describe is ok');
eq(described.body?.value?.ns, GATE_SETTINGS_NS, 'describe names the merged namespace');
eq(described.body?.value?.values?.timeoutMs, 4000, 'the composed value is described');
eq(described.body?.value?.values?.enabled, true, 'the composed enabled flag is described');
const publicDefaults = { ...GATE_DEFAULTS };
delete publicDefaults.apiKey;
same(described.body?.value?.defaults, publicDefaults, 'the defaults are the module defaults, minus the key itself');
eq(described.body?.value?.apiKeyConfigured, false, 'the card is told whether a key is stored, not what it is');
ok(!JSON.stringify(described.body).includes('"apiKey":'), 'and no /describe answer carries an apiKey member');
same(
	described.body?.value?.credential,
	{ ref: 'OPENROUTER_API_KEY', configured: false },
	'the credential is reported as ref + boolean, never a value'
);

// A card edit: one field, merged into the user layer, live for the next call.
const mutated = await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/mutate'), { body: { patch: { enabled: false } } });
eq(mutated.status, 200, 'mutate answers');
eq(mutated.body?.ok, true, 'mutate is ok');
eq(mutated.body?.value?.enabled, false, 'the response carries the new effective value');
same(state.updates, [{ ns: GATE_SETTINGS_NS, patch: { enabled: false } }], 'the write goes through the merged namespace');
eq(live().enabled, false, 'the judge sees the new value with no restart');
eq(live().timeoutMs, 4000, 'the composed fields the card did not touch survive the merge');

// A rejected patch is a 200 carrying a code and the field's own message.
const rejected = await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/mutate'), { body: { patch: { nope: 1 } } });
eq(rejected.status, 200, 'a refused patch is still a 200');
same(rejected.body, { ok: false, code: 'settings-rejected', message: 'gate has unknown key(s) nope' }, 'the refusal names the unknown key');
eq(state.updates.length, 1, 'a refused patch writes nothing');
eq(
	(await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/mutate'), { body: { patch: { timeoutMs: 0 } } })).body?.message,
	'gate `timeoutMs` must be a positive integer',
	'timeoutMs is validated'
);
eq(
	(await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/mutate'), { body: { patch: { enabled: 'yes' } } })).body?.message,
	'gate `enabled` must be a boolean',
	'enabled is validated'
);
eq(
	(await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/mutate'), { body: { patch: 'x' } })).body?.message,
	'gate must be an object',
	'a non-object patch is refused'
);

// The status line reads the in-memory last verdict and the effective numbers.
eq((await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/status'))).body?.value?.lastVerdict, null, 'no judgement yet');
verdicts.last = { allow: false, reason: 'judged implementation_work (confidence 0.1, change-probability 0.9)', at: 1 };
const status = await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/status'));
eq(status.body?.value?.enabled, false, 'status reports the live enabled flag');
eq(status.body?.value?.effectiveTimeoutMs, 4000, 'status reports the live timeout');
eq(status.body?.value?.allowConfidence, GATE_DEFAULTS.allowConfidence, 'status reports the live threshold');
eq(status.body?.value?.lastVerdict?.reason, verdicts.last.reason, 'status reports the last judgement verbatim');
eq(status.body?.value?.apiKeyConfigured, false, 'status reports no stored key yet');

// --- the JEV connection: which endpoint, model and key the judge really gets --
// The card writes three fields and nothing else. The plugin's live gate is the
// object it handed this file's settings stub (0.1.7 hands the seam a live
// reference), so writing it here is what a card save does to the running judge.
// Then the REAL pre-execute runs the REAL delegationBlock and the request the
// judge would have received is read off the wire.
const connGate = applySettings.applied[0]?.entry;
ok(connGate !== undefined && typeof connGate === 'object', 'the mount handed the settings seam its own gate object');
const routesOf = (gateValues) => makeGateRoutes(service, {
	gate: () => ({ ...GATE_DEFAULTS, ...gateValues }),
	verdicts,
	credential: async () => ({ ref: GATE_DEFAULTS.apiKeyRef, configured: false })
});
const requests = [];
const realFetchAgain = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	requests.push({ url: String(url), auth: init?.headers?.Authorization, body: JSON.parse(init.body) });
	return new Response(JSON.stringify({
		answers: { intent: { choice: 'read_only_research', confidence: 0.9 }, work: { noul: 0.1 } }
	}), { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
	const delegate = () => preExecuteHandler({
		name: 'subagent',
		arguments: { description: 'look', prompt: 'Read src/app.js and report what it does.' },
		agent: trailAgent
	}, next);

	// (1) a stored key and a saved endpoint are the ones the request uses
	Object.assign(connGate, {
		apiKey: 'sk-test-123',
		baseUrl: 'http://127.0.0.1:4599/api/v1',
		model: 'my/custom-judge-1'
	});
	const connRoutes = routesOf(connGate);
	eq((await callRoute(connRoutes[0])).body?.value?.apiKeyConfigured, true, 'the saved key reads back as configured');
	eq(await delegate(), allowed, 'the JEV branch judges with the saved connection');
	eq(requests.length, 1, 'exactly one judge request leaves the gate');
	eq(requests[0]?.url, 'http://127.0.0.1:4599/api/v1/systemone', 'the saved API address is the endpoint, with /systemone appended');
	eq(requests[0]?.auth, 'Bearer sk-test-123', 'the stored plain key is the bearer, and it wins over the credential reference');
	eq(requests[0]?.body?.model, 'my/custom-judge-1', 'the saved model id is what the judge is asked with');

	// (2) reading the card never echoes the key, and never clears it
	ok(!JSON.stringify(await callRoute(connRoutes[0])).includes('sk-test-123'), 'no bridge answer echoes the stored key');
	eq(connGate.apiKey, 'sk-test-123', 'the stored key survives the card read');

	// (3) a replacement key is the next request's bearer
	Object.assign(connGate, { apiKey: 'sk-test-456' });
	requests.length = 0;
	await delegate();
	eq(requests[0]?.auth, 'Bearer sk-test-456', 'the next judgement carries the replacement key');

	// (4) the follow branch reads neither the key nor the endpoint
	Object.assign(connGate, { backend: 'llm' });
	requests.length = 0;
	logged.length = 0;
	const followed = await delegate();
	eq(requests.length, 0, 'the follow branch sends nothing to the JEV endpoint, even with a key and an address stored');
	eq(followed?.kind, 'deny', 'and fails closed here, because this stub host exposes no llm service');
	matches(format(...logged.filter((args) => String(args[0]).startsWith('dsh-cursor-modes: delegation gate '))), /backend=llm/, 'the follow judgement is logged as backend=llm');
	eq((await callRoute(routesOf(connGate)[0])).body?.value?.values?.baseUrl, 'http://127.0.0.1:4599/api/v1', 'the saved endpoint is still stored while the follow branch ignores it');
} finally {	globalThis.fetch = realFetchAgain;
}

// Guards: another origin, another verb, and a malformed body never reach a handler.
eq((await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/describe'), { remoteAddress: '10.0.0.5' })).status, 403, 'the card bridge is loopback only (address)');
eq((await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/describe'), { host: 'evil.example:3080' })).status, 403, 'the card bridge is loopback only (host header)');
eq((await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/describe'), { method: 'GET' })).status, 405, 'the card bridge is POST only');
eq((await callRoute(routeOf(GATE_BRIDGE_PREFIX + '/mutate'))).status, 400, 'a missing body is refused');

// Without the namespace registered — or without a settings service at all —
// both editable routes refuse cleanly instead of throwing.
const bare = makeSettingsStub(baseGate);
const bareHooks = { gate: () => baseGate, verdicts, credential: async () => ({ ref: 'R', configured: false }) };
const bareRoutes = makeGateRoutes({ ...bare.service, describe: () => [] }, bareHooks);
const unavailableDescribe = await callRoute(bareRoutes[0]);
eq(unavailableDescribe.status, 200, 'an unregistered namespace still answers 200');
eq(unavailableDescribe.body?.ok, false, 'with a refusal body');
eq(unavailableDescribe.body?.code, 'settings-unavailable', 'and the settings-unavailable code');
eq((await callRoute(bareRoutes[1], { body: { patch: { enabled: true } } })).body?.code, 'settings-unavailable', 'mutate refuses the same way');
const noServiceRoutes = makeGateRoutes(undefined, bareHooks);
eq((await callRoute(noServiceRoutes[0])).body?.code, 'settings-unavailable', 'no settings service at all is refused, not thrown');
eq((await callRoute(noServiceRoutes[1], { body: { patch: {} } })).body?.code, 'settings-unavailable', 'mutate too');
// The status route still answers: it reports the runtime, not the settings doc.
eq((await callRoute(noServiceRoutes[2])).body?.ok, true, 'status answers without a settings service');

// --- summary -----------------------------------------------------------------
if (realProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = realProfile;
if (realDshHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = realDshHome;
rmSync(fakeHome, { recursive: true, force: true });

for (const failure of failures) console.error('FAIL: ' + failure);
console.log('self-check-runtime: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) process.exit(1);
