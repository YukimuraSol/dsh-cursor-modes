#!/usr/bin/env node
// self-check-plandoc.mjs — the plan-doc mount decision: which plan file a tool
// call publishes to the client, and when.
//
// The decision used to be a tool-name whitelist (write / edit /
// str_replace_editor), so a plan file rewritten by pwsh or by run_code's fs
// never refreshed the card. It is now "the plan file THIS CALL touched", found
// by scanning plans/ for mtimes inside the call window, with a claim layer that
// keeps two sessions from mounting each other's plans.
//
// The record is written in post-execute, inside the call, because the client's
// turn-tail card only accepts a record whose seq is before the turn's closing
// reply (selectCreatePlan: plan.seq < owner.seq). Three writes in one turn are
// therefore three records and the card shows the last one; nothing mounts at
// turn end.
//
// Seven scenarios, one line each. Node straight up, no framework: a temp DSH_HOME
// per scenario, a plain session object, and the projection's own record seam.
//
// Usage: node self-check-plandoc.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { notePlanActivity, notePlanCallStart } from './lib/plan.js';
import { createState } from './lib/state.js';
import { setModeEventAppend } from './lib/projection.js';

// The shipped writer needs a live host Session; the seam observes the exact
// type and payload without one.
const records = [];
setModeEventAppend((session, type, data) => {
	records.push({ session, type, data });
	return records.length;
});

let passed = 0;
const failures = [];
function ok(condition, label, detail) {
	if (condition) {
		passed++;
		console.log('ok   ' + label);
	} else {
		failures.push(label + (detail === undefined ? '' : ' (' + detail + ')'));
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
let turn = 0;
const roots = [];

/** One isolated world: a temp DSH_HOME, a fresh state bag, a stub host. */
function scenario(mode = 'plan') {
	const root = mkdtempSync(join(tmpdir(), 'dsh-plandoc-'));
	roots.push(root);
	process.env.DSH_HOME = root;
	const dir = join(root, 'plans');
	mkdirSync(dir, { recursive: true });
	turn += 1;
	const session = { id: 'session-' + (++seq), mode };
	const host = {
		logger: { warn() {} },
		sessionProjections: {
			stateOf: (s, key) => (key === 'turnBoundary' ? { lastTurn: turn } : { mode: s.mode })
		}
	};
	return { dir, session, host, state: createState() };
}

/** One tool call: pre-execute stamps the window. */
function start(ctx, name, args = {}) {
	const exec = { name, arguments: args, agent: { session: ctx.session } };
	notePlanCallStart(ctx.state);
	return exec;
}

/** One tool call: post-execute mounts; returns the records it wrote. */
function finish(ctx, exec, value) {
	const before = records.length;
	notePlanActivity(ctx.host, ctx.state, exec, { isError: false, value });
	return records.slice(before);
}

const planPath = (ctx, base) => join(ctx.dir, base + '.plan.md');

/** A create_plan call: writes the file, returns its path in the tool value. */
function createPlan(ctx, base, text) {
	const path = planPath(ctx, base);
	const exec = start(ctx, 'create_plan');
	writeFileSync(path, text, 'utf8');
	finish(ctx, exec, { title: 't', path, todos: [] });
	return path;
}

/** A plan file already in the directory before this call opened. */
function preexisting(ctx, base, text) {
	const path = planPath(ctx, base);
	writeFileSync(path, text, 'utf8');
	return path;
}

const planDoc = (out) => out.filter((record) => record.type === 'plugin:cursormodes/plandoc');

// ===========================================================================
// 1. a claimed plan rewritten by write mounts, in that call
// ===========================================================================
{
	const ctx = scenario();
	const path = createPlan(ctx, 'alpha_11111111', 'v0');
	records.length = 0;
	await sleep(3);

	const exec = start(ctx, 'write', { file_path: path });
	writeFileSync(path, 'v1', 'utf8');
	const out = planDoc(finish(ctx, exec));

	ok(out.length === 1 && out[0].data.path === path && out[0].data.plan === 'v1',
		'write on a claimed plan -> exactly one plandoc, written in that call',
		JSON.stringify(out.map((r) => r.data)));
}

// ===========================================================================
// 2. the same file rewritten by pwsh, no tool-name whitelist
// ===========================================================================
{
	const ctx = scenario();
	const path = createPlan(ctx, 'beta_22222222', 'v0');
	records.length = 0;
	await sleep(3);

	const exec = start(ctx, 'pwsh', { command: 'Set-Content -LiteralPath X v1' });
	writeFileSync(path, 'v1', 'utf8');
	const out = planDoc(finish(ctx, exec));

	ok(out.length === 1 && out[0].data.path === path && out[0].data.plan === 'v1',
		'pwsh on a claimed plan -> the same one plandoc, no whitelist involved',
		JSON.stringify(out.map((r) => r.data)));
}

// ===========================================================================
// 3. not in plan mode -> nothing mounted
// ===========================================================================
{
	const ctx = scenario();
	const path = createPlan(ctx, 'gamma_33333333', 'v0');
	records.length = 0;
	await sleep(3);
	ctx.session.mode = 'default';

	const exec = start(ctx, 'pwsh', { command: 'Set-Content -LiteralPath X v1' });
	writeFileSync(path, 'v1', 'utf8');
	const out = planDoc(finish(ctx, exec));

	ok(out.length === 0, 'default mode -> no plandoc', 'records=' + out.length);
}

// ===========================================================================
// 4. three edits of one plan in one turn -> THREE records, last content last
// ===========================================================================
{
	const ctx = scenario();
	const path = createPlan(ctx, 'delta_44444444', 'v0');
	records.length = 0;
	await sleep(3);

	for (const text of ['v1', 'v2', 'v3']) {
		const exec = start(ctx, 'write', { file_path: path });
		writeFileSync(path, text, 'utf8');
		finish(ctx, exec);
		await sleep(3);
	}

	const out = planDoc(records.slice());
	ok(out.length === 3 && out.at(-1).data.plan === 'v3',
		'three edits in one turn -> three plandocs, the last one carries the last content',
		JSON.stringify(out.map((r) => r.data.plan)));
}

// ===========================================================================
// 5. two plans in one turn -> two records, the later plan last
// ===========================================================================
{
	const ctx = scenario();
	const first = createPlan(ctx, 'epsilon_55555555', 'first-v0');
	const second = createPlan(ctx, 'zeta_66666666', 'second-v0');
	records.length = 0;
	await sleep(3);

	let exec = start(ctx, 'write', { file_path: first });
	writeFileSync(first, 'first-v1', 'utf8');
	finish(ctx, exec);
	await sleep(5);
	exec = start(ctx, 'write', { file_path: second });
	writeFileSync(second, 'second-v1', 'utf8');
	finish(ctx, exec);

	const out = planDoc(records.slice());
	ok(out.length === 2 && out.at(-1).data.path === second,
		'two plans in one turn -> two plandocs, the later one last',
		JSON.stringify(out.map((r) => r.data.path)));
}

// ===========================================================================
// 6. a file that was already there and was never claimed -> never mounted
// ===========================================================================
{
	const ctx = scenario();
	const theirs = preexisting(ctx, 'eta_77777777', 'a plan from another session');
	await sleep(3);

	const exec = start(ctx, 'pwsh', { command: 'Set-Content -LiteralPath X edited' });
	writeFileSync(theirs, 'a plan from another session, edited', 'utf8');
	const out = planDoc(finish(ctx, exec));

	ok(out.length === 0,
		'an unclaimed plan (there before the call) -> no mount even though its mtime matches',
		'records=' + out.length);
}

// ===========================================================================
// 7. a plan born inside the call window -> claimed on the spot and mounted
// ===========================================================================
{
	const ctx = scenario();
	await sleep(3);
	const path = planPath(ctx, 'theta_88888888');

	const exec = start(ctx, 'pwsh', { command: 'New-Item + Set-Content' });
	writeFileSync(path, '# a plan born in this call', 'utf8');
	const out = planDoc(finish(ctx, exec));

	ok(out.length === 1 && out[0].data.path === path && out[0].data.plan === '# a plan born in this call',
		'a plan created inside the call -> claimed by its own birth time and mounted',
		JSON.stringify(out.map((r) => r.data)));
}

// ===========================================================================
// summary
// ===========================================================================
setModeEventAppend(undefined);
delete process.env.DSH_HOME;
for (const root of roots) rmSync(root, { recursive: true, force: true });
for (const failure of failures) console.error('FAIL: ' + failure);
console.log('self-check-plandoc: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) process.exit(1);
