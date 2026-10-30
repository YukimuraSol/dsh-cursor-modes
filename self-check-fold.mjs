/**
 * Projection migration self-check (blueprint §3.5).
 *
 * This layer fails SILENTLY when it is wrong: an unmatched event type makes
 * `foldMode` return the state untouched, the fold lands on `default`, and
 * nothing throws or warns. So no assertion here may be "the code looks right";
 * every one of the three layers below is external evidence.
 *
 *   Layer 1  six golden sessions + the plugin:-prefixed sample, expected end
 *            state hardcoded. Catches "both sides wrong together".
 *   Layer 1c the write path: the shipped writer must append ONE `ignorable`
 *            `plugin:cursormodes/state` record that a host without this plugin
 *            can restore, and the two names must fold identically.
 *   Layer 2  sweep every session on disk, fold it with the FROZEN legacy folds
 *            (tools/legacy-fold.mjs) and with the new projection, require zero
 *            mismatch. Catches "the new fold disagrees with what shipped".
 *            Only sessions carrying a LEGACY mode event are compared: since
 *            0.2.3 the sole writer is `plugin:cursormodes/state`, a name the
 *            frozen baseline is pinned never to learn, so it folds those
 *            streams to `default` by design. Comparing them would measure the
 *            baseline's blindness, not a regression. New-only sessions are
 *            counted (`not comparable`) and a floor keeps the sweep honest.
 *   Layer 3  drive the host's own `restoreReleasedV4Artifact`. (a) old sessions
 *            open once the legacy types are registered; (b) with those types
 *            stripped from the whitelist the restore MUST throw
 *            /unknown event type/. Without (b), a permanently-throwing bug and
 *            a passing test look identical.
 *
 * Run: node self-check-fold.mjs        (exit 0 = all green)
 *
 * Baseline measured 2026-10-07 on this box (blueprint recorded 382/181/157/12
 * when the count was 382 v4 files; the file count drifts, the ratios do not):
 *   389 session files total = 382 v4 + 7 v3
 *   sessions containing a mode event ....... 181
 *   end state not `default` ................. 157
 *   sessions that were once both-on ........ 12
 *   legacy/new fold mismatch ................ 0
 *   restorable with registration ............ 374 of 381 usable v4 (7 pre-existing
 *                                             structural defects, see the notes
 *                                             printed by layer 3a)
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { KNOWN_SESSION_EVENT_TYPES, Session } from '@deepseek-ai/dsh-session';
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4';

import {
	MODE_EVENT,
	MODE_RECORD,
	PLAN_DOC_EVENT,
	PLAN_DOC_RECORD,
	appendModeEvent,
	appendPlanDocEvent,
	LEGACY_PLAN_EVENT,
	LEGACY_PLAN_DOC_EVENT,
	LEGACY_MULTI_EVENT,
	foldMode,
	modeInit,
	modeView,
	registerModeEventTypes
} from './lib/projection.js';
import { foldCreatePlanEvents, isPlanDocEvent, toolResultText } from './lib/create-plan-fold.js';
import { legacyFoldSession } from './tools/legacy-fold.mjs';

// ---------------------------------------------------------------------------
// Where the sessions live.
// ---------------------------------------------------------------------------

const SESSIONS_ROOT =
	'D:\\DSH Pack Launcher\\dsh-packs\\dsh-fallback-4000\\sessions';

// ---------------------------------------------------------------------------
// Multi-frame zstd decoding (§3.5.2). Three traps, all real:
//
//   trap 1  zstdDecompressSync(wholeBuffer) decompresses only the FIRST frame
//           and returns it. No error. (Measured: 584KB -> 229 bytes, 1 line.)
//   trap 2  zlib.createZstdDecompress() streamed the same buffer, same result.
//   trap 3  a truncated frame returns 0 bytes instead of throwing, so the
//           "continue on error" path must also drop empty output.
//
// The file is a bare concatenation of independent frames, one per append, so
// the only correct decode is: find every magic, slice to the next magic,
// decompress each slice on its own, keep the non-empty parts.
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Offsets of every zstd frame magic in `buffer`. */
function magicOffsets(buffer) {
	const at = [];
	for (let i = buffer.indexOf(ZSTD_MAGIC, 0); i >= 0; i = buffer.indexOf(ZSTD_MAGIC, i + 4)) at.push(i);
	return at;
}

/** Decode every frame in `buffer` and concatenate the results as UTF-8. */
export function decodeZstdFrames(buffer) {
	const at = magicOffsets(buffer);
	const parts = [];
	for (let k = 0; k < at.length; k++) {
		const slice = buffer.subarray(at[k], at[k + 1] ?? buffer.length);
		let part;
		try {
			part = zstdDecompressSync(slice);
		} catch {
			continue; // trap 3: truncated frame
		}
		if (part?.length) parts.push(part); // trap 3: zero-byte decode
	}
	const text = Buffer.concat(parts).toString('utf8');
	if (!text) throw new Error('decoded nothing — multi-frame split failed');
	return text;
}

/**
 * Read one session file and SELF-PROVE the decode is complete.
 *
 * "It did not throw" is not proof — the trap-1 single-frame bug also does not
 * throw. Density is the proof: `seq` is 0-based and gapless, so a half-decoded
 * file shows a short event list whose last seq does not match its length.
 *
 * @param {string} file
 * @returns {{ header: object | null, events: object[], frames: number }}
 */
export function readSession(file) {
	const raw = readFileSync(file);
	const frames = magicOffsets(raw).length;
	const lines = decodeZstdFrames(raw).split('\n').filter(Boolean);

	let header = null;
	let body = lines;
	try {
		const first = JSON.parse(lines[0]);
		if (first?.type === 'session') {
			const { type: _type, ...rest } = first;
			header = rest;
			body = lines.slice(1);
		}
	} catch {
		// not a session header — leave header null, keep every line as an event
	}

	const events = body.map((line) => JSON.parse(line));

	// —— decode-completeness proof, per file
	assert.ok(events.length > 0, `decoded zero events — multi-frame split failed: ${file}`);
	assert.strictEqual(
		events.at(-1).seq - events[0].seq,
		events.length - 1,
		`events must be dense (decode incomplete): ${file}`
	);
	if (header !== null) {
		assert.strictEqual(events[0].seq, 0, `first event seq must be 0: ${file}`);
	}
	assert.ok(frames > 1 ? events.length > 1 : true, `single-frame claim sanity: ${file}`);

	return { header, events, frames };
}

/** Every `session.v*.jsonl.zstd` under the sessions root. Slug-agnostic by design. */
export function allSessionFiles(root = SESSIONS_ROOT) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) out.push(path);
		}
	};
	walk(root);
	return out.sort();
}

/** Locate a session directory by id (the cwd slug is not reconstructible). */
function findSession(id) {
	const hit = allSessionFiles().filter((file) => file.includes(`\\${id}\\`));
	assert.ok(hit.length > 0, `session not found: ${id}`);
	return hit;
}

/** Fold one event list through the new projection. */
function foldNew(events) {
	let state = modeInit();
	for (const event of events) state = foldMode(state, event);
	return state;
}

/** Does the event list contain a mode-bearing event (legacy or new)? */
function hasModeEvent(events) {
	return events.some((event) =>
		/^(?:plugin:)?(?:cursorPlan\/state|cursorPlan\/planDoc|mode\/selected|cursormodes\/state)$/.test(event.type ?? '')
	);
}

const fileLabel = (file) => file.slice(SESSIONS_ROOT.length + 1);

// ---------------------------------------------------------------------------
// Capture the host's NATIVE whitelist BEFORE anything registers into it.
// Layer 3b needs the native set plus the new event type, minus the legacy three.
// ---------------------------------------------------------------------------

const NATIVE_EVENT_TYPES = new Set(KNOWN_SESSION_EVENT_TYPES);

// ---------------------------------------------------------------------------
// The tool-result wire shape. A native tool message carries its ContentBlock[]
// in `message.content` itself — measured on both hosts (0.2.1-rc.2 web and
// 0.2.1-rc.3 desktop) as `content: [{ type: 'text', text: 'Plan file: …' }]`.
// There is no `content[0].content` wrapper. Reading one returned "" for every
// plan, which silently disabled the card's checklist, View Plan and dispatch
// stamp (desktop regression 2026-10-30), while every bridge/self-check passed
// because they seed `resultText` directly. These three assertions make the
// wire shape itself the thing that fails.
// ---------------------------------------------------------------------------

const flatToolResult = {
	content: [{ type: 'text', text: 'Plan file: C:\\tmp\\x.plan.md\nPlan "x" created.' }],
	source: { kind: 'tool', callId: 'call-flat' }
};
assert.strictEqual(
	toolResultText(flatToolResult),
	'Plan file: C:\\tmp\\x.plan.md\nPlan "x" created.',
	'toolResultText must read the flat message.content blocks'
);
const errorToolResult = { content: [{ type: 'text', text: 'boom' }], isError: true, source: { kind: 'tool', callId: 'call-err' } };
const erroredFold = foldCreatePlanEvents([
	{ type: 'turn/start', seq: 0, data: { turn: 1 } },
	{ type: 'tool/call', seq: 1, data: { callId: 'call-err', turn: 1, name: 'create_plan', arguments: '{"name":"x","plan":"# x"}' } },
	{ type: 'tool/result', seq: 2, surfaceOp: 'append', data: { turn: 1, message: errorToolResult } }
]);
assert.deepStrictEqual(erroredFold.plans, [], 'an errored create_plan must not settle a card');
const settledFold = foldCreatePlanEvents([
	{ type: 'turn/start', seq: 0, data: { turn: 1 } },
	{ type: 'tool/call', seq: 1, data: { callId: 'call-flat', turn: 1, name: 'create_plan', arguments: '{"name":"x","plan":"# x"}' } },
	{ type: 'tool/result', seq: 2, surfaceOp: 'append', data: { turn: 1, message: flatToolResult } }
]);
assert.strictEqual(settledFold.plans.length, 1, 'a successful create_plan must settle one card');
assert.match(settledFold.plans[0].resultText, /^Plan file: /, 'the settled card must carry the plan path');
console.log('plan-card wire shape: flat tool-result text extracts the plan path');

console.log('=== dsh-cursor-modes projection self-check ===');
console.log(`sessions root: ${SESSIONS_ROOT}`);
console.log(`host native event vocabulary: ${NATIVE_EVENT_TYPES.size} types`);
for (const legacy of [LEGACY_PLAN_EVENT, LEGACY_PLAN_DOC_EVENT, LEGACY_MULTI_EVENT]) {
	assert.ok(!NATIVE_EVENT_TYPES.has(legacy), `${legacy} is already native — this check would prove nothing`);
}

const ALL_FILES = allSessionFiles();
const V4_FILES = ALL_FILES.filter((file) => /session\.v4\.jsonl\.zstd$/.test(file));
console.log(`session files: ${ALL_FILES.length} (${V4_FILES.length} v4, ${ALL_FILES.length - V4_FILES.length} other)`);

// ===========================================================================
// Layer 1 — golden sessions, hardcoded expected end state.
// ===========================================================================

console.log('\n--- Layer 1: golden sessions (hardcoded expectations) ---');

const GOLDEN = [
	// only a cursorPlan/state@22 {plan} -> plan. Smallest plan-only sample.
	['session-095d01ed-2265-4f71-95a0-b9ae56e6a4bf', 'plan'],
	// only a mode/selected@5 {multi} -> multi. Smallest multi-only sample.
	['session-05cd4aed-cdcc-4336-9564-f9b8e97e7246', 'multi'],
	// plan@5 -> multi@48 -> plan-null@49. THE counterexample: "last seq wins"
	// takes the later plan-null and answers default. Must be multi.
	['session-02430976-29d2-48fd-bc9d-a49c46b29c24', 'multi'],
	// plan@21 -> plan-null@41. Opened then closed -> default.
	['session-03679485-4c17-4c95-bfd8-15a43b3728b5', 'default'],
	// plan@5 -> multi@27 -> plan-null@28 -> multi-null@69. Both on at one point,
	// ends default. Proves the two latches must be independent.
	['session-5dbbdd96-b9de-4762-9cbd-c47929babedc', 'default'],
	// plan@24 -> null@48 -> multi@56 -> multi-null@86 -> plan@87 -> null@106.
	['session-1e8ccb13-6715-41d1-9758-d1b7b6edf022', 'default']
];

for (const [id, want] of GOLDEN) {
	const files = findSession(id);
	const v4 = files.find((file) => /session\.v4\./.test(file));
	assert.ok(v4, `no v4 file for golden ${id}`);
	const { events } = readSession(v4);
	const state = foldNew(events);
	assert.strictEqual(state.mode, want, `${id}: expected end mode ${want}, got ${state.mode}`);
	assert.strictEqual(
		state.plan ? 'plan' : state.multi ? 'multi' : 'default',
		state.mode,
		`${id}: derived mode disagrees with its latches`
	);
	console.log(`  ok  ${id.slice(8, 16)}  -> ${state.mode}`);
}

// ---------------------------------------------------------------------------
// Layer 1b — the ONLY sample that exercises `plugin:` prefix stripping.
//
// session-964b1370 has both a v3 file and a v4 file. The v4 file's 33 legacy
// mode events are all rewritten to `plugin:cursorPlan/state` / `plugin:mode/selected`
// with `ignorable: true`; without the strip those names match nothing and the
// fold answers `default` while the legacy fold answers `multi`.
// ---------------------------------------------------------------------------

console.log('\n--- Layer 1b: plugin: prefix stripping (session-964b1370) ---');

const PREFIX_SAMPLE = 'session-964b1370-ef78-497a-949e-20b24b49b8d2';
const prefixFiles = findSession(PREFIX_SAMPLE);
const prefixV3 = prefixFiles.find((file) => /session\.v3\./.test(file));
const prefixV4 = prefixFiles.find((file) => /session\.v4\./.test(file));
assert.ok(prefixV3 && prefixV4, 'session-964b1370 must have both a v3 and a v4 file');

const v3Events = readSession(prefixV3).events;
const v4Events = readSession(prefixV4).events;

const modeEventOf = (event) => /^(?:plugin:)?(?:cursorPlan\/state|mode\/selected)$/.test(event.type ?? '');
const prefixedModeEvents = v4Events.filter(
	(event) => String(event.type ?? '').startsWith('plugin:') && modeEventOf(event)
);
assert.ok(prefixedModeEvents.length > 0, 'no plugin:-prefixed mode events — nothing to prove');
assert.ok(
	prefixedModeEvents.every((event) => event.ignorable === true),
	'plugin:-prefixed mode events must all be ignorable'
);

const v4New = foldNew(v4Events);
const v4Legacy = legacyFoldSession(v4Events);
const v3New = foldNew(v3Events);

assert.strictEqual(v4New.mode, 'multi', `${PREFIX_SAMPLE} v4: expected multi, got ${v4New.mode}`);
assert.strictEqual(v4Legacy.mode, 'multi', `${PREFIX_SAMPLE} v4 legacy fold: expected multi`);
assert.strictEqual(v3New.mode, 'multi', `${PREFIX_SAMPLE} v3: expected multi`);
assert.strictEqual(v4New.mode, v3New.mode, 'the v3 and v4 copies of this session must fold identically');

// Teeth for the strip itself: replay only up to the LAST prefixed mode event.
// There the legacy fold (which cannot see `plugin:` names) lands on default while
// the new fold must still say multi — i.e. the strip is what makes them agree.
const lastPrefixedIndex = v4Events.lastIndexOf(prefixedModeEvents.at(-1));
const prefixOnly = v4Events.slice(0, lastPrefixedIndex + 1);
assert.strictEqual(foldNew(prefixOnly).mode, 'multi', 'prefix strip lost — new fold saw no prefixed event');
assert.strictEqual(
	legacyFoldSession(prefixOnly).mode,
	'default',
	'prefix-strip teeth lost — the legacy fold can no longer tell them apart'
);

console.log(`  ok  ${PREFIX_SAMPLE.slice(8, 16)}  v3 -> ${v3New.mode}   v4 -> ${v4New.mode}   legacy(v4) -> ${v4Legacy.mode}`);
console.log(`  ok  plugin:-prefixed mode events: ${prefixedModeEvents.length} (all ignorable:true)`);
console.log(`  ok  prefix-strip teeth: up to last prefixed event, new=${foldNew(prefixOnly).mode} legacy=${legacyFoldSession(prefixOnly).mode}`);

// ---------------------------------------------------------------------------
// Layer 1c — the WRITE path: one `ignorable` plugin record, folded exactly like
// the old name, and readable by a host that does not know it.
//
// 0.2.1 wrote `cursormodes/state` through `session.append`, which stamps no
// `ignorable` marker: the host refused the WHOLE log once this plugin was
// uninstalled, because the only thing that had made the type legal was this
// plugin's load-time registration. 0.2.3 writes `plugin:cursormodes/state`
// through `appendPluginRecord`. This layer proves the record opens on the bare
// native whitelist, that the two names fold identically, and (teeth) that
// removing the marker brings the refusal back.
// ---------------------------------------------------------------------------

console.log('\n--- Layer 1c: the plugin record write path ---');

for (const mode of ['default', 'plan', 'multi']) {
	const oldFold = foldMode(modeInit(), { type: MODE_EVENT, data: { mode } });
	const newFold = foldMode(modeInit(), { type: MODE_RECORD, data: { mode } });
	assert.deepStrictEqual(newFold, oldFold, `${mode}: the old and new event names must fold identically`);
}
console.log('  ok  old `cursormodes/state` and new `plugin:cursormodes/state` fold identically in all three modes');

const recordSession = Session.create('session-cursormodes-record');
appendModeEvent(recordSession, 'plan');
const record = recordSession.log.at(-1);
assert.strictEqual(record.type, MODE_RECORD, 'the shipped writer must emit the plugin record');
assert.strictEqual(record.ignorable, true, 'the record must carry ignorable: true, or an uninstalled host refuses the log');
assert.strictEqual(record.data.mode, 'plan', 'the record payload is the committed mode');
console.log(`  ok  writer: ${record.type} ${JSON.stringify(record.data)} (ignorable: ${record.ignorable})`);

const recordHeader = {
	version: 4,
	id: 'session-cursormodes-record-reader',
	createdAt: Date.now(),
	delegationDepth: 0,
	isSeeded: false
};
const recordEvents = JSON.parse(JSON.stringify(recordSession.log));
const bareWhitelist = new Set(NATIVE_EVENT_TYPES);
const restoredRecord = restoreReleasedV4Artifact(
	{ header: recordHeader, inheritedEventCount: 0, events: recordEvents },
	bareWhitelist
);
assert.ok(
	restoredRecord.events.some((event) => event.type === MODE_RECORD),
	'a reader without this plugin must keep the record, not drop the log'
);
console.log('  ok  a bare native whitelist restores the log and retains the record');

const strippedRecordEvents = recordEvents.map(({ ignorable, ...rest }) => rest);
assert.throws(
	() => restoreReleasedV4Artifact(
		{ header: recordHeader, inheritedEventCount: 0, events: strippedRecordEvents },
		bareWhitelist
	),
	/unknown event type/,
	'teeth: without ignorable the same record must make the log unreadable'
);
console.log('  ok  teeth: the same record without `ignorable` is refused with "unknown event type"');

// ---------------------------------------------------------------------------
// Layer 1d — the plan-body write path: ONE `ignorable` record, and BOTH names
// read by the plan card's fold.
//
// Up to 0.2.3 the body went out through `session.append(cursorPlan/planDoc)`.
// Same disease as layer 1c: uninstalling the plugin made every session that had
// ever written a plan unopenable. 0.2.4 writes `plugin:cursormodes/plandoc`
// through `appendPlanDocEvent`.
// ---------------------------------------------------------------------------

console.log('\n--- Layer 1d: the planDoc plugin record ---');

// Fold skip: the body event must leave the mode state untouched under both names.
{
	const before = modeInit();
	for (const type of [LEGACY_PLAN_DOC_EVENT, PLAN_DOC_RECORD]) {
		assert.deepStrictEqual(
			foldMode(before, { type, data: { turn: 4, path: 'p', plan: 'x' } }),
			before,
			type + ' must not touch the mode fold'
		);
	}
}
console.log('  ok  the mode fold skips planDoc under both names');

// The card's fold reads both names, and the migrated legacy spelling too.
const docCardEvents = (type) => [
	{ type: 'turn/start', seq: 1, data: { turn: 4 } },
	{ type, seq: 2, data: { turn: 4, path: 'C:/w/a.plan.md', plan: '# Plan\n\nBody.\n' } }
];
for (const type of [PLAN_DOC_EVENT, 'plugin:cursorPlan/planDoc', PLAN_DOC_RECORD]) {
	assert.strictEqual(isPlanDocEvent(type), true, type + ' must be recognised as a planDoc');
	const folded = foldCreatePlanEvents(docCardEvents(type));
	assert.strictEqual(folded?.plans.length, 1, type + ' must settle one card update');
	assert.strictEqual(JSON.parse(folded.plans[0].argsRaw).plan, '# Plan\n\nBody.\n', type + ' must carry the body');
}
assert.strictEqual(isPlanDocEvent('cursorPlan/state'), false, 'teeth: the mode event is not a planDoc');
console.log('  ok  card fold reads ' + PLAN_DOC_EVENT + ', its plugin: form and ' + PLAN_DOC_RECORD);

// The writer: ONE ignorable record on a real Session, retained by a bare
// whitelist, refused without the marker.
const docRecordSession = Session.create('session-cursormodes-plandoc-record');
const docBody = { turn: 3, path: 'C:/w/b.plan.md', plan: '# P\n' };
appendPlanDocEvent(docRecordSession, docBody);
const docRecord = docRecordSession.log.at(-1);
assert.strictEqual(docRecord.type, PLAN_DOC_RECORD, 'the shipped writer must emit the plugin record');
assert.strictEqual(docRecord.ignorable, true, 'the planDoc record must carry ignorable: true');
assert.deepStrictEqual(docRecord.data, docBody, 'the record payload is turn, path and body');
const docRecordEvents = JSON.parse(JSON.stringify(docRecordSession.log));
const docRestored = restoreReleasedV4Artifact(
	{ header: recordHeader, inheritedEventCount: 0, events: docRecordEvents },
	new Set(NATIVE_EVENT_TYPES)
);
assert.ok(
	docRestored.events.some((event) => event.type === PLAN_DOC_RECORD),
	'a bare native whitelist must keep the planDoc record'
);
assert.throws(
	() => restoreReleasedV4Artifact(
		{
			header: recordHeader,
			inheritedEventCount: 0,
			events: JSON.parse(JSON.stringify(docRecordSession.log)).map(({ ignorable, ...rest }) => rest)
		},
		new Set(NATIVE_EVENT_TYPES)
	),
	/unknown event type/,
	'teeth: without ignorable the planDoc record must make the log unreadable'
);
console.log(
	'  ok  writer: ' + docRecord.type + ' (ignorable: ' + docRecord.ignorable
	+ ') restores on the bare whitelist; without the marker it is refused'
);

// ===========================================================================
// Layer 2 — sweep every session, compare against the frozen legacy folds.
// ===========================================================================

console.log('\n--- Layer 2: sweep vs frozen legacy folds ---');

let withModeEvents = 0;
let nonDefault = 0;
let bothOn = 0;
let mismatch = 0;
let comparable = 0;
let newOnly = 0;
const mismatches = [];

for (const file of ALL_FILES) {
	const { events } = readSession(file);
	if (!hasModeEvent(events)) continue;
	withModeEvents++;

	// Was this session ever both plan and multi at once? The old two-latch
	// reality, and the reason a single-value fold cannot be correct.
	let plan = false;
	let multi = false;
	let everBoth = false;
	// Did the FROZEN baseline get to see anything here? Since 0.2.3 the only
	// writer is `plugin:cursormodes/state`, a name tools/legacy-fold.mjs is
	// pinned never to learn. It folds such a stream to `default` BY DESIGN, so
	// comparing it against the new fold is a category error, not a regression.
	// Those sessions are counted and skipped, never compared.
	let sawLegacy = false;
	for (const event of events) {
		const type = String(event.type ?? '').replace(/^plugin:/, '');
		if (type === LEGACY_PLAN_EVENT) { plan = event.data?.mode === 'plan'; sawLegacy = true; }
		else if (type === LEGACY_MULTI_EVENT) { multi = event.data?.mode === 'multi'; sawLegacy = true; }
		else if (type === MODE_EVENT) {
			const mode = event.data?.mode;
			plan = mode === 'plan';
			multi = mode === 'multi';
		}
		if (plan && multi) everBoth = true;
	}
	if (everBoth) bothOn++;

	const next = foldNew(events);
	if (next.mode !== 'default') nonDefault++;
	if (!sawLegacy) { newOnly++; continue; }
	comparable++;

	const legacy = legacyFoldSession(events);
	if (next.mode !== legacy.mode) {
		mismatch++;
		if (mismatches.length < 10) mismatches.push([fileLabel(file), next.mode, legacy.mode]);
	}
}

for (const [file, got, want] of mismatches) console.error(`  MISMATCH ${got} != legacy ${want}  ${file}`);
assert.ok(withModeEvents >= 170, `sweep too small: ${withModeEvents} sessions with mode events`);
assert.ok(comparable >= 150, `legacy-comparable sweep too small: ${comparable} — the frozen baseline has gone blind`);
assert.strictEqual(mismatch, 0, `${mismatch} of ${comparable} legacy-comparable sessions fold differently from legacy`);

console.log(`  sweep: ${withModeEvents} sessions with mode events, ${comparable} comparable, ${mismatch} mismatch`);
console.log(`  not comparable (new-only stream, baseline cannot name it): ${newOnly}`);
console.log(`  end state: ${nonDefault} non-default, ${withModeEvents - nonDefault} default`);
console.log(`  sessions that were once both plan+multi: ${bothOn}`);

// A session with no mode events at all must fold to default, or every
// untouched session silently inherits a mode.
{
	const plain = ALL_FILES.filter((file) => !hasModeEvent(readSession(file).events));
	for (const file of plain) {
		assert.strictEqual(foldNew(readSession(file).events).mode, 'default', `${fileLabel(file)}: no mode event but mode is not default`);
	}
	console.log(`  ok  ${plain.length} sessions without mode events all fold to default`);
}

// `pending` semantics. The new `wanted` is `true | null` (direction lives in
// `running.target`), so `pending === (wanted === true)` by construction. The
// reachable-state invariants worth pinning:
//
//   command/run  for a mode command -> running set, wanted cleared
//   command/done                    -> running cleared, wanted possibly true
//                                      (committed switch still owed an event)
//   any commit event                -> wanted cleared
//
// `wanted === true` with `running === null` is a LEGAL state — it is exactly
// "the command finished, the commit event has not arrived yet". Asserting
// otherwise would encode the old `wanted: false` shape back into the new one.
{
	let checked = 0;
	let pendingSeen = 0;
	for (const file of ALL_FILES) {
		const events = readSession(file).events;
		let state = modeInit();
		for (const event of events) {
			const type = String(event.type ?? '').replace(/^plugin:/, '');
			const before = state;
			state = foldMode(state, event);
			const view = modeView(state);
			assert.strictEqual(typeof view.pending, 'boolean', 'modeView.pending must be a boolean');
			assert.strictEqual(view.pending, state.wanted === true, 'pending must be exactly wanted === true');
			assert.strictEqual(view.mode, state.mode, 'modeView.mode must be the folded mode');

			if (type === 'command/run') {
				const modeCommand = event.data?.name === 'cursor-plan' || event.data?.name === 'cursor-multi';
				if (modeCommand) {
					assert.ok(state.running !== null, 'a mode command must record a target');
					// NB: `command/run` spreads the state, so `wanted` is preserved
					// verbatim — only `command/done` and a commit event clear it.
					assert.strictEqual(state.wanted, before.wanted, 'command/run must not clear the owed switch');
					checked++;
				} else assert.strictEqual(state, before, 'unrelated commands must not touch the mode state');
			} else if (type === 'command/done' && before.running !== null && event.data?.commandId === before.running.commandId) {
				assert.strictEqual(state.running, null, 'a finished command clears running');
				checked++;
			} else if (type === LEGACY_PLAN_EVENT || type === LEGACY_MULTI_EVENT || type === MODE_EVENT) {
				assert.strictEqual(state.wanted, null, 'a commit event clears the owed switch');
				assert.strictEqual(state.running === null || state.running !== null, true);
			}
			if (view.pending) pendingSeen++;
		}
	}
	console.log(`  ok  pending semantics held across ${checked} command events (${pendingSeen} pending observations)`);
}

// ===========================================================================
// Layer 3 — the host's own restore path, both directions.
// ===========================================================================

console.log('\n--- Layer 3: restoreReleasedV4Artifact sensitivity ---');

// Only well-formed v4 artifacts: one file on disk is a truncated fragment whose
// first line is an event rather than a session header (pre-existing, unrelated
// to this migration). Everything that parses as v4 gets restored.
const prepared = [];
let malformed = 0;
for (const file of V4_FILES) {
	const { header, events } = readSession(file);
	if (header === null || header.version !== 4) {
		malformed++;
		continue;
	}
	prepared.push({ file, header, events });
}
console.log(`  usable v4 artifacts: ${prepared.length} (skipped ${malformed} malformed, see Layer 1 notes)`);

// —— 3a: registration makes every old session readable.
const registered = registerModeEventTypes();
console.log(`  registered event types: ${registered.join(', ')}`);
for (const type of registered) {
	assert.ok(KNOWN_SESSION_EVENT_TYPES.has(type), `${type} not in the live vocabulary after registration`);
}

let restored = 0;
const unknownTypeFailures = [];
const structuralFailures = [];
for (const { file, header, events } of prepared) {
	try {
		restoreReleasedV4Artifact({ header, inheritedEventCount: 0, events }, KNOWN_SESSION_EVENT_TYPES);
		restored++;
	} catch (error) {
		const message = String(error?.message ?? error);
		if (/unknown event type/.test(message)) unknownTypeFailures.push([fileLabel(file), message]);
		else structuralFailures.push([fileLabel(file), message]);
	}
}

for (const [file, message] of unknownTypeFailures.slice(0, 10)) {
	console.error(`  UNREACHABLE-AFTER-REGISTRATION ${file}\n    ${message}`);
}
assert.strictEqual(
	unknownTypeFailures.length,
	0,
	`${unknownTypeFailures.length} sessions still fail with "unknown event type" after registration`
);
assert.ok(restored >= 370, `only ${restored} of ${prepared.length} sessions restored`);
console.log(`  (a) ok  ${restored}/${prepared.length} sessions restore, 0 "unknown event type"`);
if (structuralFailures.length > 0) {
	console.log(`      ${structuralFailures.length} pre-existing structural failures, none about event types:`);
	for (const [file, message] of structuralFailures) {
		console.log(`        ${file.split('\\').at(-2)}: ${message}`);
	}
}

// —— 3b: teeth. Drop the three legacy types; the restore MUST throw.
// Without this, a bug that always throws and a test that always passes are
// indistinguishable — (a) alone would still look green.
const withoutLegacy = new Set(
	[...NATIVE_EVENT_TYPES, MODE_EVENT].filter(
		(type) => type !== LEGACY_PLAN_EVENT && type !== LEGACY_PLAN_DOC_EVENT && type !== LEGACY_MULTI_EVENT
	)
);
assert.strictEqual(withoutLegacy.has(LEGACY_PLAN_EVENT), false, 'legacy type still present — no teeth');
assert.strictEqual(withoutLegacy.has(LEGACY_MULTI_EVENT), false, 'legacy type still present — no teeth');

/** The three old event names, prefix-tolerant (a migrated file says `plugin:<name>`). */
const isLegacyModeType = (type) =>
	[LEGACY_PLAN_EVENT, LEGACY_PLAN_DOC_EVENT, LEGACY_MULTI_EVENT].includes(String(type ?? '').replace(/^plugin:/, ''));

let strippedThrew = 0;
let strippedPassed = [];
for (const { file, header, events } of prepared) {
	if (!events.some((event) => isLegacyModeType(event.type))) continue;
	try {
		restoreReleasedV4Artifact({ header, inheritedEventCount: 0, events }, withoutLegacy);
		strippedPassed.push(fileLabel(file));
	} catch (error) {
		assert.match(
			String(error?.message ?? error),
			/unknown event type/,
			`${fileLabel(file)}: expected "unknown event type", got "${error?.message}"`
		);
		strippedThrew++;
	}
}
assert.strictEqual(
	strippedPassed.length,
	0,
	`sensitivity lost: ${strippedPassed.length} sessions still restored without the legacy types`
);
assert.ok(strippedThrew > 0, 'sensitivity check failed: nothing threw, the test cannot detect a missing registration');
console.log(`  (b) ok  ${strippedThrew} sessions throw /unknown event type/ with the legacy types stripped`);

// The golden counterexample must be one of them — a session whose fold needs
// the legacy stream is exactly the one that must become unreadable.
{
	const [file] = findSession('session-02430976-29d2-48fd-bc9d-a49c46b29c24').filter((f) => /v4/.test(f));
	const { header, events } = readSession(file);
	assert.throws(
		() => restoreReleasedV4Artifact({ header, inheritedEventCount: 0, events }, withoutLegacy),
		/unknown event type/,
		'sensitivity check failed on the golden counterexample'
	);
	console.log('  (b) ok  golden counterexample session-02430976 throws without registration');
}

// ===========================================================================
// Summary
// ===========================================================================

console.log('\n=== ALL GREEN ===');
console.log(`golden: ${GOLDEN.length + 1} samples (incl. plugin:-prefix sample)`);
console.log(`sweep: ${withModeEvents} sessions, ${mismatch} mismatch`);
console.log(`mode end states: ${nonDefault} non-default / ${withModeEvents - nonDefault} default`);
console.log(`both-on sessions: ${bothOn}`);
console.log(`restore: (a) ${restored}/${prepared.length} ok, (b) ${strippedThrew} throw when stripped`);
