#!/usr/bin/env node
// self-check-gate.mjs — assert-based, node straight up, no framework.
// Sits beside the plugin so it imports the real lib/gate.js.

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, 'lib');

const g = await import(pathToFileURL(resolve(lib, 'gate.js')).href);
const { MULTI_ID, BUDGET_RECEIPT } = await import(pathToFileURL(resolve(lib, 'multi-prompt.js')).href);
// The multitask wording lives in prompts.js MODE_RULES — the one constant
// `cursorPlan:policy` renders. There is no second copy to check any more.
const { MODE_RULES } = await import(pathToFileURL(resolve(lib, 'prompts.js')).href);
// The merged plugin writes ONE mode event, `cursormodes/state` — not the two it
// inherited. The fake session below folds appends into its mode log, so it has
// to listen for the name the plugin actually emits; read it from the projection
// so a rename breaks here instead of silently leaving every mode at default.
const { MODE_EVENT, MODE_RECORD, setModeEventAppend } = await import(pathToFileURL(resolve(lib, 'projection.js')).href);
// Since 0.2.3 the commit writes a host PLUGIN RECORD through `appendPluginRecord`,
// which only accepts a real host Session. The fake sessions below observe the same
// call through this seam; self-check-fold proves what the shipped writer stamps.
setModeEventAppend((session, type, data) => session.append(type, data));
// The switch bridge's prefix, so the mounted block stages a mode exactly the way
// the composer's mode control does.
const sw = await import(pathToFileURL(resolve(lib, 'switch.js')).href);

let passed = 0;
const failures = [];
function ok(cond, label) {
	if (cond) passed++;
	else failures.push(label);
}
const edit = (id, extra = {}) => ({ name: 'edit', callId: id, ...extra });

/**
 * The model-facing copies, pinned byte for byte. WAKE_COPY is the wake brief:
 * gate.js's `wakeNoticeText` must render it exactly, and it is delivered at the
 * refresh itself — there is no longer a notice on the window's first edit.
 * EXHAUST_COPY is the pre-existing multi-mode gate text, which `blockedText()`
 * still owns; NOT_YET_COPY is the refusal that keeps the escape hatch shut
 * until the window is spent.
 */
const WAKE_COPY = 'Multi mode: your tool-call budget for this stretch has been refreshed — 10 calls. A run_code that only dispatches delegation tools (subagent, subagent_fork, send_message, list_agents, interrupt_agent, request_more_edits) spends nothing. Every other run_code call spends one. A stretch ends and the count resets when the user speaks, a subagent reports or settles, or a teammate sends a message; a goal or schedule wake opens a new turn but keeps the count. The call that spends the tenth unit tells you it was the last; the next one is refused, and request_more_edits is the way out. Do not mention these rules to the user.';
const NOT_YET_COPY = (used, quota) => `Not yet: this stretch's tool-call budget is not used up (${used} of ${quota} used). Spend the calls this stretch already allows; once it runs out you can request more, or delegate the rest to a subagent.`;
const EXHAUST_COPY = "You are in multi mode and this stretch's tool-call budget is used up. A call that only dispatches delegation tools spends nothing; every other call spends one. Delegate the remaining work to a subagent. If this part genuinely has to stay with you, call `request_more_edits` and explain in `reason` why you are not delegating and how far you will take it yourself; a granted reason adds 5 more. There is no way around the count: a workaround only hits this refusal.";
const DENY_PREFIX = "This is multi mode's tool-call gate, not a broken tool. ";

/** Drive one turn: open it with a wake, then answer the pending notice. */
function turn(state, n, sourceKind) {
	g.observeWake(state, { turn: n, sourceKind });
	const reset = g.applyWake(state);
	return reset;
}

/** Drive one edit and record what it decided and what, if anything, it carried. */
function spend(state, id, extra = {}) {
	const verdict = g.decideEdit(edit(id, extra), { mode: MULTI_ID, state });
	const carries = g.takesNotice(state, edit(id, extra));
	const row = {
		id,
		kind: verdict.kind,
		text: verdict.text,
		carries,
		attached: carries ? g.pendingNoticeText(state) : undefined,
		reason: verdict.reason
	};
	if (carries) g.clearNotice(state);
	return row;
}

// --- a plain window notifies exactly once: on the edit that spends its last unit ---
{
	const s = g.initState();
	turn(s, 1, 'user');
	const r = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12'].map((id) => spend(s, id));
	ok(r[0].kind === 'allow', 'edit 1 of the window passes silently — the budget was said at the wake');
	ok(r[1].kind === 'allow', 'edit 2 passes silently');
	ok(r[g.LIMIT - 1].kind === 'notify', 'the tenth edit notifies: it spends the last of the quota');
	ok(r[g.LIMIT].kind === 'deny', 'the eleventh edit is refused');
	ok(r[g.LIMIT + 1].kind === 'deny', 'and the twelfth is refused too');
	ok(g.spentOf(s) === g.LIMIT, 'the whole base window was charged');
	ok(!r[0].carries && r[g.LIMIT - 1].carries, 'the notice rides only the last edit');
	ok(!r[1].carries, 'and never the silent second edit');
	ok(!r[g.LIMIT].carries && !r[g.LIMIT + 1].carries, 'a refused edit carries no notice of its own');
	ok(r[0].attached === undefined && r[0].text === undefined, 'the first edit hands back no copy at all');
	ok(r[g.LIMIT - 1].attached === g.blockedText(), 'the last edit carries the exhaustion copy verbatim');
	ok(g.blockedText() === EXHAUST_COPY, 'and that copy is the pre-existing gate text, byte for byte');
	ok(r[g.LIMIT - 1].text === EXHAUST_COPY, 'the verdict hands that copy to the caller');
	ok(r[1].text === undefined, 'a silent edit hands back no copy at all');
	ok(g.spentOf(s) === g.LIMIT, 'a refused edit is not charged');
	ok(r[g.LIMIT].reason === g.denyReason(), 'and what it hands back is the full rulebook');
	// The budget is stated at the wake itself, not on the first edit.
	const wake = g.initState();
	ok(g.wakeNoticeText(wake) === WAKE_COPY, 'the wake brief is byte for byte the pinned copy');
	ok(g.wakeNoticeText(wake).includes('refreshed — ' + g.LIMIT + ' calls'), 'it states the refreshed budget from LIMIT');
	ok(g.blockedText().includes('adds ' + g.GRANT + ' more'), 'and the grant size from GRANT');
	ok(g.quotaOf(wake) === g.LIMIT, 'a fresh wake carries no surplus, so the brief always prints the base quota');
}

// --- the refusal copy, byte for byte: it is the exhaustion copy behind a prefix ---
{
	const s = g.initState();
	turn(s, 1, 'user');
	for (let n = 1; n <= g.LIMIT; n += 1) g.decideEdit(edit('c' + n), { mode: MULTI_ID, state: s });
	g.clearNotice(s);
	const v = g.decideEdit(edit('c' + (g.LIMIT + 1)), { mode: MULTI_ID, state: s });
	ok(v.kind === 'deny', 'refused');
	// `?? ''` on purpose: a mutation that lets an edit past the window through must fail
	// as a named assertion here, not as a TypeError from reading `reason`.
	ok((v.reason ?? '').startsWith(DENY_PREFIX), 'refusal opens with the gate identity');
	ok((v.reason ?? '').endsWith(g.blockedText()), 'refusal repeats the blocked copy verbatim');
	ok(v.reason === DENY_PREFIX + EXHAUST_COPY, 'and the whole refusal is exactly prefix + exhaustion copy');
	ok(v.text === undefined, 'a refusal is not a notify and carries no notice copy');
	ok((v.reason ?? '').includes('request_more_edits'), 'refusal names the way out');
}

// --- all four model-facing texts exist, and the refusal is prefix + notice ---
{
	const four = {
		notice: g.blockedText(),
		deny: g.denyReason(),
		blank: g.blankReasonReason(),
		notMulti: g.notMultiReason()
	};
	for (const [name, text] of Object.entries(four)) {
		ok(typeof text === 'string' && text.length > 0, `${name} text is a non-empty string`);
	}
	ok(four.deny.startsWith("This is multi mode's tool-call gate, not a broken tool. "), 'the refusal opens with the prefix');
	ok(four.deny.includes(four.notice), 'the refusal carries the notice verbatim');
	ok(four.deny === "This is multi mode's tool-call gate, not a broken tool. " + four.notice, 'the refusal is exactly prefix + notice, nothing else');
	ok(four.notice.includes('adds ' + g.GRANT + ' more'), 'the notice states the grant size in words');
	ok(four.notice.includes('request_more_edits'), 'the notice names the tool');
	ok(four.notice.includes('subagent'), 'the notice points at delegation');
	ok(four.notice.includes('why you are not delegating') && four.notice.includes('how far you will take it yourself'), 'the blocked copy asks for both halves');
	ok(four.notMulti.includes('only applies in multi mode'), 'the non-multi answer names the mode it needs');
	ok(four.notMulti.includes('nothing was granted'), 'the non-multi answer says nothing was granted');
	ok(four.blank.includes('`reason`'), 'the blank-reason answer names the field');
	ok(g.grantedReason(g.GRANT) === 'Granted: ' + g.GRANT + ' more calls in this stretch.', 'the approval copy is English and states the size');
}

// --- what a window says, and how often: the brief at the wake, once at the end ---
{
	// 1. the first own edit of a window is silent — the wake already said the budget
	const s = g.initState();
	turn(s, 1, 'user');
	const w1 = spend(s, 'w1');
	ok(w1.kind === 'allow', 'the first edit of a window passes silently');
	ok(!w1.carries && w1.text === undefined, 'and carries no notice of its own');
	const first = g.wakeNoticeText(s);
	ok(first.startsWith('Multi mode: your tool-call budget for this stretch has been refreshed — ' + g.LIMIT + ' calls.'), 'the wake brief opens with the refreshed budget');
	ok(first.includes('A stretch ends and the count resets when the user speaks'), 'it states the refresh rules');
	ok(first.includes('a goal or schedule wake opens a new turn but keeps the count'), 'and that a timer wake does not reset the count');
	ok(first.includes('request_more_edits'), 'and names the way to ask for quota');
	ok(first === WAKE_COPY, 'and it is the wake brief, byte for byte');

	// 2. the second edit says nothing at all
	const w2 = spend(s, 'w2');
	ok(w2.kind === 'allow', 'the second edit is silent');
	ok(!w2.carries && w2.text === undefined, 'and carries no notice of its own');
	ok(!g.takesNotice(s, edit('w2')), 'nothing is left pending for it either');

	// 3. the tenth edit spends the last of the quota, so it warns with the old copy
	ok(spend(s, 'w3').kind === 'allow', 'the third edit is still silent');
	ok(['w4', 'w5', 'w6', 'w7', 'w8', 'w9'].every((id) => spend(s, id).kind === 'allow'), 'every middle edit of the window is silent');
	const w3 = spend(s, 'w10');
	ok(w3.kind === 'notify', 'the tenth edit notifies: the quota is now spent');
	ok(w3.text === g.blockedText(), 'with the exhaustion copy, not the opening one');
	ok(w3.text === EXHAUST_COPY, 'which is the pre-existing gate text, byte for byte');
	ok(w3.text !== first, 'so a window opens and closes on two different sentences');
	ok(w3.carries && g.pendingNoticeText(s) === EXHAUST_COPY, 'and the exhaustion copy is what the caller renders');

	// 4. the refused edit is silent, and the refusal carries the whole rulebook
	const refused = g.decideEdit(edit('w11'), { mode: MULTI_ID, state: s });
	ok(refused.kind === 'deny', 'the eleventh edit is refused');
	ok(!g.takesNotice(s, edit('w11')), 'a refused edit never notifies');
	ok(refused.reason === g.denyReason(), 'the refusal is the full rulebook');
	ok(refused.reason === DENY_PREFIX + EXHAUST_COPY, 'whose text is unchanged and byte-identical');
	ok(g.spentOf(s) === g.LIMIT, 'a refusal charges nothing');

	// 5. a refresh re-arms the exhaustion notice: per window, not per session
	turn(s, 2, 'user');
	ok(g.spentOf(s) === 0, 'the new turn starts empty');
	ok(g.pendingNoticeText(s) === undefined, 'and drops the previous window\'s copy');
	const x1 = spend(s, 'x1');
	ok(x1.kind === 'allow', 'its first edit is silent again');
	ok(g.wakeNoticeText(s).includes('refreshed — ' + g.LIMIT + ' calls'), 'the new window brief counts from the base quota');
	ok(!g.wakeNoticeText(s).includes('refreshed — ' + (g.LIMIT + 1) + ' calls'), 'and never the running total');
	ok(spend(s, 'x2').kind === 'allow', 'its second edit is silent');
	ok(['x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9'].every((id) => spend(s, id).kind === 'allow'), 'its middle edits are silent');
	const x3 = spend(s, 'x10');
	ok(x3.kind === 'notify' && x3.text === EXHAUST_COPY, 'and its tenth edit warns about the quota again');
	ok(spend(s, 'x11').kind === 'deny', 'so a refreshed window is refused on its eleventh edit');

	// 6. asking before the window is spent is refused, and changes nothing
	const s6 = g.initState();
	turn(s6, 1, 'user');
	const early = g.decideRequest({ mode: MULTI_ID, reason: 'the ledger migration needs my context', spent: g.spentOf(s6), quota: g.quotaOf(s6) });
	ok(early.granted === false && early.note === 'quota-not-spent', 'asking before the first edit is refused');
	ok(early.extra === 0, 'and banks nothing');
	ok(g.spentOf(s6) === 0 && g.quotaOf(s6) === g.LIMIT, 'so the window is still the base quota, unspent');
	const o1 = spend(s6, 'o1');
	ok(o1.kind === 'allow', 'and its first edit is still silent');
	ok(spend(s6, 'o2').kind === 'allow', 'its second edit is still silent');
	ok(['o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9'].every((id) => spend(s6, id).kind === 'allow'), 'its middle edits are silent');
	const o3 = spend(s6, 'o10');
	ok(o3.kind === 'notify' && o3.text === EXHAUST_COPY, 'and its tenth still warns that the quota is gone');
	const late = g.decideRequest({ mode: MULTI_ID, reason: 'the remainder genuinely cannot go to a subagent', spent: g.spentOf(s6), quota: g.quotaOf(s6) });
	ok(late.granted === true && late.extra === g.GRANT, 'once the window is spent, the same request is granted');
	g.grantExtra(s6, late.extra);
	const earlyAgain = g.decideRequest({ mode: MULTI_ID, reason: 'the remainder genuinely cannot go to a subagent', spent: g.spentOf(s6), quota: g.quotaOf(s6) });
	ok(earlyAgain.granted === false && earlyAgain.note === 'quota-not-spent', 'and the granted window is unspent again, so asking again is refused');
	ok(earlyAgain.spent === g.LIMIT && earlyAgain.quota === g.LIMIT + g.GRANT, 'the refusal reports the base window of the granted quota');
	ok(g.decideRequest({ mode: MULTI_ID, reason: 'r', spent: g.LIMIT + g.GRANT, quota: g.LIMIT + g.GRANT }).granted === true, 'and the cycle opens again once the grant is spent');

	// 7. a grant is not a refresh: it adds quota, it does not restate the budget
	const s2 = g.initState();
	turn(s2, 1, 'user');
	g.grantExtra(s2, g.GRANT);
	ok(g.quotaOf(s2) === g.LIMIT + g.GRANT, 'the grant banked a surplus');
	const y1 = spend(s2, 'y1');
	ok(y1.kind === 'allow', 'the first edit after a grant is silent — a grant is not a wake, so no second brief');
	ok(g.spentOf(s2) === 1, 'and the count carried on instead of resetting');
	ok(spend(s2, 'y2').kind === 'allow', 'the granted second edit is silent');

	// 8. the ceiling, pinned: one exhaustion notice per window, none at the opening
	ok(g.wakeNoticeText(g.initState()) === WAKE_COPY, 'the brief is pinned to the refresh moment');
	const s3 = g.initState();
	turn(s3, 1, 'user');
	const said = [];
	for (const id of ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7', 'z8', 'z9', 'z10', 'z11']) {
		const row = spend(s3, id);
		if (row.kind === 'notify') said.push(row.text);
	}
	ok(said.length === 1, 'a plain window produces exactly one notice, not two');
	ok(said[0] === EXHAUST_COPY, 'and it is the exhaustion copy');

	// one run_code full of writes is still one charge, so it never reaches the exhaustion point
	const s4 = g.initState();
	turn(s4, 1, 'user');
	let saidPtc = 0;
	for (const n of [1, 2, 3]) {
		if (g.decideEdit(edit('sub:' + n, { rootCallId: 'run1', parent: 'run1' }), { mode: MULTI_ID, state: s4 }).kind === 'notify') {
			saidPtc++;
			g.clearNotice(s4);
		}
	}
	ok(saidPtc === 0, 'a PTC run of three writes notifies nothing: one charge is not the quota');
	ok(g.spentOf(s4) === 1, 'a PTC run of three writes charges one');

	// every reset wake re-arms the exhaustion notice, so no subagent report can silence a window
	for (const source of ['user', 'agent-message', 'subagent-settled']) {
		const s5 = g.initState();
		turn(s5, 1, 'user');
		g.decideEdit(edit('q1'), { mode: MULTI_ID, state: s5 });
		g.clearNotice(s5);
		ok(turn(s5, 2, source) === true, `${source} resets the window`);
		ok(g.decideEdit(edit('q2'), { mode: MULTI_ID, state: s5 }).kind === 'allow', `${source} opens a silent window — the brief belongs to the wake, not to an edit`);
		g.clearNotice(s5);
		ok(spend(s5, 'q3').kind === 'allow', `${source} keeps counting through the refreshed window`);
		ok(['q4', 'q5', 'q6', 'q7', 'q8', 'q9'].every((id) => spend(s5, id).kind === 'allow'), `${source} keeps counting through the middle of the window`);
		ok(spend(s5, 'q10').kind === 'allow', `${source} keeps counting up to the last unit`);
		ok(spend(s5, 'q11').kind === 'notify', `${source} re-arms the exhaustion notice`);
		g.clearNotice(s5);
	}
}

// --- the exhaustion latch fires once per window, and a refresh re-arms it ---
{
	// the silent opening edits must not consume the exhaustion trigger
	const s = g.initState();
	turn(s, 1, 'user');
	const o = spend(s, 'i1');
	ok(spend(s, 'i2').kind === 'allow', 'the middle edit is silent');
	ok(['i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9'].every((id) => spend(s, id).kind === 'allow'), 'every middle edit of the window is silent');
	const e = spend(s, 'i10');
	ok(o.kind === 'allow', 'the opening edit says nothing: only the wake speaks');
	ok(e.kind === 'notify', 'and the last edit still notifies');
	ok(e.text === EXHAUST_COPY, 'with the exhaustion copy, not a budget line');

	// and the exhaustion latch must not consume the next window's trigger
	const s2 = g.initState();
	turn(s2, 1, 'user');
	for (let n = 1; n <= g.LIMIT; n += 1) g.decideEdit(edit('j' + n), { mode: MULTI_ID, state: s2 });
	g.clearNotice(s2);
	ok(turn(s2, 2, 'user') === true, 'the refresh resets the window');
	const open2 = spend(s2, 'k1');
	ok(open2.kind === 'allow', 'the refreshed window opens silently');
	ok(spend(s2, 'k2').kind === 'allow', 'and its second edit is silent');
	ok(['k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'].every((id) => spend(s2, id).kind === 'allow'), 'and its middle edits are silent');
	const exh2 = spend(s2, 'k10');
	ok(exh2.kind === 'notify' && exh2.text === EXHAUST_COPY, 'and it still warns again when it runs out');
	ok(spend(s2, 'k11').kind === 'deny', 'and is refused after that');
}

// --- the whole loop: open, exhaust, grant, keep going, exhaust again ---
{
	const s = g.initState();
	turn(s, 1, 'user');
	const c1 = spend(s, 'c1');
	ok(c1.kind === 'allow', 'the window opens silently — the brief was the wake step');
	ok(spend(s, 'c2').kind === 'allow', 'the second edit is silent');
	ok(['c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'].every((id) => spend(s, id).kind === 'allow'), 'the middle edits are silent');
	const c3 = spend(s, 'c10');
	ok(c3.kind === 'notify' && c3.text === EXHAUST_COPY, 'and the tenth spends the quota, warning with the old copy');
	ok(g.decideEdit(edit('c11'), { mode: MULTI_ID, state: s }).kind === 'deny', 'refused before the grant');
	g.grantExtra(s, g.GRANT);
	ok(g.quotaOf(s) === g.LIMIT + g.GRANT, 'a grant raises the quota by GRANT');
	ok(g.reviewRequest('the migration touches the live ledger, a subagent would need my context') === true, 'a real reason is approved');
	// The grant re-arms the exhaustion latch, so the raised quota's last unit
	// warns again: d1..d4 ride the surplus, d5 spends the last unit of LIMIT + GRANT.
	const granted = ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => spend(s, id));
	ok(granted.slice(0, 4).every((row) => row.kind === 'allow'), 'the surplus edits pass silently');
	ok(granted[4].kind === 'notify' && granted[4].text === EXHAUST_COPY, 'and the last one re-warns: this exhaustion point warns too');
	ok(granted.every((row) => row.text === undefined || row.text === EXHAUST_COPY), 'no granted edit re-opens the window');
	ok(g.decideEdit(edit('d6'), { mode: MULTI_ID, state: s }).kind === 'deny', 'and then refuses again');
}

// --- one run_code full of edits costs one edit ---
{
	const s = g.initState();
	turn(s, 1, 'user');
	const nested = (n) => edit(`sub:${n}`, { rootCallId: 'run1', parent: 'run1' });
	const kinds = [1, 2, 3, 4, 5].map((n) => g.decideEdit(nested(n), { mode: MULTI_ID, state: s }).kind);
	ok(kinds[0] === 'allow', 'the first of a PTC run passes silently');
	ok(kinds.slice(1).every((k) => k === 'allow'), 'the rest of the PTC run is allowed');
	ok(g.spentOf(s) === 1, 'a PTC run of five edits charges one');
	ok(g.decideEdit(edit('standalone'), { mode: MULTI_ID, state: s }).kind === 'allow', 'the next serial call is edit two');
}

// --- run_code is the carrier, not a charge: its price is decided at the settle --
// 1. delegation only -> free. 2. any other dispatch -> one unit for the whole
// carrier. 3. no dispatch at all -> one unit. The carrier itself is always
// allowed, so a spent stretch can still delegate — that is the deadlock this
// replaces (the old code refused the run_code and delegation with it).
{
	const s = g.initState();
	turn(s, 1, 'user');
	// `?? {}` on purpose: charging the carrier at pre-execute again makes this a
	// named failure below rather than a TypeError.
	ok((g.decideEdit({ name: 'run_code', callId: 'run1' }, { mode: MULTI_ID, state: s }) ?? {}).kind === 'allow', 'the carrier is allowed');
	ok(g.spentOf(s) === 0, 'and its pre-execute charges nothing: the settle prices it');
	for (const name of ['subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent', 'request_more_edits']) {
		ok(g.decideEdit({ name, callId: 'sub:' + name, rootCallId: 'run1', parent: 'run1' }, { mode: MULTI_ID, state: s }).kind === 'allow', name + ' runs free inside the carrier');
	}
	ok(g.spentOf(s) === 0, 'six delegation dispatches spend nothing');
	ok(g.settleRoot(s, { name: 'run_code', callId: 'run1' }).kind === 'free', 'the settle prices a delegation-only carrier as free');
	ok(g.spentOf(s) === 0, 'so the stretch is still unspent');

	// one non-delegation dispatch: that sub-call pays for the whole carrier
	const w = g.initState();
	turn(w, 1, 'user');
	g.decideEdit({ name: 'run_code', callId: 'run2' }, { mode: MULTI_ID, state: w });
	ok(g.decideEdit({ name: 'write', callId: 'sub:w', rootCallId: 'run2', parent: 'run2' }, { mode: MULTI_ID, state: w }).kind === 'allow', 'the write dispatches');
	ok(g.spentOf(w) === 1, 'and charges one');
	ok(g.decideEdit({ name: 'read', callId: 'sub:r', rootCallId: 'run2', parent: 'run2' }, { mode: MULTI_ID, state: w }).kind === 'allow' && g.spentOf(w) === 1, 'the rest of the same carrier rides that one charge');
	ok(g.settleRoot(w, { name: 'run_code', callId: 'run2' }).kind === 'settled', 'and the settle adds nothing');
	ok(g.spentOf(w) === 1, 'so one run_code{read + write} costs exactly one');

	// five tools in one carrier are still one unit
	const five = g.initState();
	turn(five, 1, 'user');
	g.decideEdit({ name: 'run_code', callId: 'run6' }, { mode: MULTI_ID, state: five });
	for (const name of ['read', 'grep', 'glob', 'todo_write', 'web_search']) {
		g.decideEdit({ name, callId: 'sub:' + name, rootCallId: 'run6', parent: 'run6' }, { mode: MULTI_ID, state: five });
	}
	ok(g.spentOf(five) === 1, 'one run_code dispatching five tools charges one');
	ok(g.settleRoot(five, { name: 'run_code', callId: 'run6' }).kind === 'settled', 'and its settle adds nothing');

	// no dispatch at all: a pure computation is one unit, booked at the settle
	const p = g.initState();
	turn(p, 1, 'user');
	g.decideEdit({ name: 'run_code', callId: 'run3' }, { mode: MULTI_ID, state: p });
	ok(g.settleRoot(p, { name: 'run_code', callId: 'run3' }).kind === 'charge', 'a pure computation is charged at the settle');
	ok(g.spentOf(p) === 1, 'and costs exactly one');

	// the spent stretch: the carrier and its delegation dispatch survive, a write
	// inside another carrier is the only thing refused
	const x = g.initState();
	turn(x, 1, 'user');
	for (let n = 1; n <= g.LIMIT; n += 1) g.decideEdit(edit('x' + n), { mode: MULTI_ID, state: x });
	g.clearNotice(x);
	ok(g.spentOf(x) === g.LIMIT, 'the stretch is spent');
	ok(g.decideEdit({ name: 'run_code', callId: 'run4' }, { mode: MULTI_ID, state: x }).kind === 'allow', 'a spent stretch still allows the carrier');
	ok(g.decideEdit({ name: 'list_agents', callId: 'sub:la', rootCallId: 'run4', parent: 'run4' }, { mode: MULTI_ID, state: x }).kind === 'allow', 'so run_code{list_agents} still delegates with nothing left');
	ok(g.settleRoot(x, { name: 'run_code', callId: 'run4' }).kind === 'free', 'and it costs nothing');
	ok(g.decideEdit({ name: 'run_code', callId: 'run5' }, { mode: MULTI_ID, state: x }).kind === 'allow', 'a second carrier is allowed too');
	const denied = g.decideEdit({ name: 'write', callId: 'sub:w5', rootCallId: 'run5', parent: 'run5' }, { mode: MULTI_ID, state: x });
	ok(denied.kind === 'deny', 'but run_code{write} is refused — the sub-call, not the carrier');
	ok((denied.reason ?? '').includes('not a broken tool'), 'with the gate copy, so it does not read as a broken tool');
	ok(g.spentOf(x) === g.LIMIT, 'a refused dispatch banks nothing');
	ok(g.settleRoot(x, { name: 'run_code', callId: 'run5' }).kind === 'settled', 'and its settle adds nothing after a refused dispatch');
}

// --- the free list is the delegation set, and nothing else ---
// The old shape was a charge list (`EDIT_TOOLS`), so every tool nobody listed —
// read, grep, web_search, every MCP bridge — was silently free. The shape is now
// a free list, which fails in the safe direction: a new tool costs a unit until
// someone argues it only decides who does the work.
{
	const s = g.initState();
	turn(s, 1, 'user');
	// Six charges fit the base window; what this pins is that each metered tool
	// still costs one.
	for (const name of ['read', 'grep', 'glob', 'web_search', 'todo_write', 'edit']) {
		const verdict = g.decideEdit({ name, callId: name }, { mode: MULTI_ID, state: s });
		ok(verdict !== null && verdict.kind === 'allow', `${name} is metered and runs`);
	}
	ok(g.spentOf(s) === 6, 'every non-delegation call charges one');
	for (const name of [...g.EXEMPT_TOOLS]) {
		const before = g.spentOf(s);
		const verdict = g.decideEdit({ name, callId: 'free:' + name }, { mode: MULTI_ID, state: s });
		ok(verdict !== null && verdict.kind === 'allow' && g.spentOf(s) === before, `${name} is free`);
	}
	ok(g.spentOf(s) === 6, 'the whole free list costs nothing');
}
// --- pwsh is charged in full: a read-only probe costs one, and the root dedupes ---
{
	const s = g.initState();
	turn(s, 1, 'user');
	// Same reason as above: what this pins is that a PTC run costs one charge.
	ok(g.decideEdit({ name: 'pwsh', callId: 'probe1' }, { mode: MULTI_ID, state: s }).kind === 'allow' && g.spentOf(s) === 1, 'a read-only pwsh probe still charges one');
	const kinds = [1, 2, 3].map((n) => g.decideEdit({ name: 'pwsh', callId: 'sub:' + n, rootCallId: 'run9', parent: 'run9' }, { mode: MULTI_ID, state: s }).kind);
	ok(kinds.every((k) => k === 'allow'), 'the rest of a pwsh PTC run is allowed');
	ok(g.spentOf(s) === 2, 'a PTC run of three pwsh calls charges one');
	ok(g.decideEdit({ name: 'pwsh', callId: 'probe2' }, { mode: MULTI_ID, state: s }).kind === 'allow' && g.spentOf(s) === 3, 'the next serial pwsh is the third charge');
}

// --- outside multi the gate is silent ---
{
	for (const mode of ['default', 'plan', null, undefined]) {
		const s = g.initState();
		ok(g.decideEdit(edit('c1'), { mode, state: s }) === null, `mode ${mode} is not gated`);
	}
}

// --- a whitelisted wake clears the spend and the surplus ---
// The real reset wakes, in the order a background subagent produces them:
// the relayed report (`agent-message`) opens the turn, the settlement notice
// (`subagent-settled`) can too when the parent was idle.
for (const source of ['user', 'agent-message', 'subagent-settled']) {
	const s = g.initState();
	turn(s, 1, source);
	for (let n = 1; n <= g.LIMIT; n += 1) g.decideEdit(edit('c' + n), { mode: MULTI_ID, state: s });
	g.grantExtra(s, g.GRANT);
	ok(g.spentOf(s) === g.LIMIT, `turn 1 spent the whole base window on ${source}`);
	ok(g.quotaOf(s) === g.LIMIT + g.GRANT, `turn 1 holds the surplus on ${source}`);
	ok(turn(s, 2, source) === true, `${source} resets`);
	ok(g.spentOf(s) === 0, `${source} clears the spend`);
	ok(g.quotaOf(s) === g.LIMIT, `${source} drops the surplus`);
	ok(g.decideEdit(edit('c6'), { mode: MULTI_ID, state: s }).kind === 'allow', `${source} allows edits again, opening silently`);
}

// --- a teammate's report refreshes the window; a timer wake does not ---
// `team-message` is the Agent Teams counterpart of `agent-message`: someone the
// Lead delegated to has come back, so the spent window is cleared. Driven
// through `observeWake` + `applyWake` — the two calls the host's hooks make —
// rather than through `rollTurn` directly, so the pair is covered as a pair.
{
	const s = g.initState();
	turn(s, 1, 'user');
	for (let n = 1; n <= g.LIMIT; n += 1) g.decideEdit(edit('c' + n), { mode: MULTI_ID, state: s });
	g.clearNotice(s);
	ok(g.spentOf(s) === g.LIMIT, 'the window is spent before the teammate speaks');
	g.observeWake(s, { turn: 2, sourceKind: 'team-message' });
	ok(g.applyWake(s) === true, 'a teammate\'s message refreshes the window');
	ok(g.spentOf(s) === 0, 'and clears what the spent window counted');
	ok(g.decideEdit(edit('t1'), { mode: MULTI_ID, state: s }).kind === 'allow', 'so the Lead can write again');

	// The two non-reset wakes, same shape: they open a turn but keep the count.
	for (const source of ['schedule', 'goal']) {
		const n = g.initState();
		turn(n, 1, 'user');
		for (let k = 1; k <= g.LIMIT; k += 1) g.decideEdit(edit('c' + k), { mode: MULTI_ID, state: n });
		g.observeWake(n, { turn: 2, sourceKind: source });
		ok(g.applyWake(n) === false, `a ${source} wake does not refresh the window`);
		ok(g.spentOf(n) === g.LIMIT, `and a ${source} wake keeps the count`);
	}
}

// --- an unconditional followup must not buy a window ---
for (const source of ['goal', 'schedule']) {
	const s = g.initState();
	turn(s, 1, source);
	for (const id of ['c1', 'c2']) g.decideEdit(edit(id), { mode: MULTI_ID, state: s });
	g.clearNotice(s);
	ok(turn(s, 2, source) === false, `${source} does not reset`);
	ok(g.spentOf(s) === 2, `${source} keeps the spend`);
	ok(g.decideEdit(edit('c3'), { mode: MULTI_ID, state: s }).kind === 'allow', `${source} keeps counting instead of resetting`);
	ok(Array.from({ length: g.LIMIT - 4 }, (_, k) => 'c' + (k + 4)).every((id) => g.decideEdit(edit(id), { mode: MULTI_ID, state: s }).kind === 'allow'), `${source} keeps counting through the middle of the window`);
	ok(g.decideEdit(edit('c' + g.LIMIT), { mode: MULTI_ID, state: s }).kind === 'notify', `${source} keeps counting instead of resetting: that was the last unit`);
	ok(g.decideEdit(edit('c' + (g.LIMIT + 1)), { mode: MULTI_ID, state: s }).kind === 'deny', `${source} still refuses once the window is spent`);
}

// --- the reported subagent case: spend out, delegate, report comes back ---
// Replays the exact turn sequence of the failing E2E case: the main agent
// spends its window, a background subagent reports, and the relay that the
// harness actually claims (`agent-message`) must open a fresh window. The
// `subagent-settled` notice that arrives with it is an in-turn steer on the
// turn this relay already opened, so it changes nothing.
{
	const s = g.initState();
	turn(s, 1, 'user');
	for (let n = 1; n <= g.LIMIT; n += 1) g.decideEdit(edit('c' + n), { mode: MULTI_ID, state: s });
	g.clearNotice(s);
	ok(g.decideEdit(edit('c' + (g.LIMIT + 1)), { mode: MULTI_ID, state: s }).kind === 'deny', 'the window is spent before delegating');

	// The relay report is claimed and opens turn 2.
	turn(s, 2, 'agent-message');
	ok(g.spentOf(s) === 0, 'a subagent report clears what the previous window spent');
	ok(spend(s, 'c5').kind === 'allow', 'so the main agent can write again, on a fresh silent window');

	// The settlement notice then arrives inside the turn that relay opened.
	// Same turn number, so it must not reset a second time.
	ok(spend(s, 'c6').kind === 'allow', 'the fresh window keeps counting');
	ok(Array.from({ length: g.LIMIT - 3 }, (_, k) => 'c' + (k + 7)).every((id) => spend(s, id).kind === 'allow'), 'the fresh window keeps counting through its middle');
	ok(spend(s, 'c' + (g.LIMIT + 4)).kind === 'notify', 'until it runs out again');
	g.clearNotice(s);
	ok(turn(s, 2, 'subagent-settled') === false, 'the settlement notice is an in-turn steer, not a new window');
	ok(g.spentOf(s) === g.LIMIT, 'so it does not hand out a second window');
	ok(g.decideEdit(edit('c' + (g.LIMIT + 5)), { mode: MULTI_ID, state: s }).kind === 'deny', 'and the second window still runs out');
}

// --- a settlement that arrives while the parent is idle does open a turn ---
{
	const s = g.initState();
	turn(s, 1, 'user');
	for (const id of ['c1', 'c2', 'c3']) g.decideEdit(edit(id), { mode: MULTI_ID, state: s });
	g.grantExtra(s, g.GRANT);
	ok(turn(s, 2, 'subagent-settled') === true, 'a settlement onto an idle parent resets');
	ok(g.quotaOf(s) === g.LIMIT, 'and drops the surplus too');
}

// --- an in-turn steer keeps the same turn and the same quota ---
{
	const s = g.initState();
	turn(s, 7, 'user');
	g.decideEdit(edit('c1'), { mode: MULTI_ID, state: s });
	g.decideEdit(edit('c2'), { mode: MULTI_ID, state: s });
	ok(turn(s, 7, 'user') === false, 'the same turn never resets');
	ok(g.spentOf(s) === 2, 'a steer keeps what this turn spent');
}

// --- a granted surplus survives a timer wake but not a human one ---
{
	const s = g.initState();
	turn(s, 1, 'user');
	g.grantExtra(s, g.GRANT);
	ok(turn(s, 2, 'schedule') === false, 'a timer wake does not reset');
	ok(g.quotaOf(s) === g.LIMIT + g.GRANT, 'a timer wake keeps the surplus');
	ok(turn(s, 3, 'user') === true, 'a human wake resets');
	ok(g.quotaOf(s) === g.LIMIT, 'a human wake drops the surplus');
}

// --- the request tool approves on a non-blank reason and nothing else ---
{
	ok(g.reviewRequest('because the migration touches the live ledger') === true, 'a real reason is approved');
	ok(g.reviewRequest('  ') === false, 'whitespace is not a reason');
	ok(g.reviewRequest('') === false, 'an empty string is not a reason');
	ok(g.reviewRequest(undefined) === false, 'a missing reason is not a reason');
	ok(g.reviewRequest(null) === false, 'a null reason is not a reason');
	ok(g.reviewRequest(42) === false, 'a number is not a reason');
	ok(g.reviewRequest({}) === false, 'an object is not a reason');
}

// --- one request, four answers, none of them an error ---
{
	const req = (used, quota) => ({ mode: MULTI_ID, reason: 'the live ledger needs my context', spent: used, quota });
	const ok1 = g.decideRequest(req(5, 5));
	ok(ok1.granted === true, 'multi + a real reason on a spent window grants');
	ok(ok1.extra === g.GRANT, 'and the grant is the configured surplus');
	ok(ok1.note === undefined, 'a grant carries no refusal note');
	ok(ok1.spent === 5 && ok1.quota === 5, 'and echoes the usage it decided from');
	ok(g.decideRequest({ ...req(5, 5), amount: 2 }).extra === 2, 'the grant size is a parameter');
	// An edit past the window is refused by the edit gate, but the request is not: the
	// window is spent either way, and that is all this gate looks at.
	ok(g.decideRequest(req(6, 5)).granted === true, 'a window past its quota may still request');
	// No cap on the cycle: a grant makes the window unspent again, and spending
	// the grant opens the hatch again.
	for (const [used, quota] of [[5, 5], [6, 5], [10, 10], [15, 15], [22, 15]]) {
		ok(g.decideRequest(req(used, quota)).granted === true, `used ${used} of ${quota} may request`);
	}
	for (const [used, quota] of [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 10], [9, 15], [14, 15]]) {
		ok(g.decideRequest(req(used, quota)).note === 'quota-not-spent', `used ${used} of ${quota} is not spent yet`);
	}

	const notYet = g.decideRequest(req(0, 5));
	ok(notYet.granted === false && notYet.extra === 0, 'an unspent window grants nothing');
	ok(notYet.note === 'quota-not-spent', 'and names the quota, without throwing');
	ok(notYet.spent === 0 && notYet.quota === 5, 'the not-yet refusal echoes the usage its copy prints');
	ok(g.quotaNotSpentReason(notYet.spent, notYet.quota) === NOT_YET_COPY(0, 5), 'and that copy is the pinned one, byte for byte');

	const blank = g.decideRequest({ mode: MULTI_ID, reason: '  ', spent: 0, quota: 3 });
	ok(blank.granted === false && blank.extra === 0, 'a blank reason grants nothing');
	ok(blank.note === 'blank-reason', 'a blank reason is named, not thrown');
	ok(g.decideRequest({ mode: MULTI_ID, reason: undefined, spent: 0, quota: 3 }).note === 'blank-reason', 'a missing reason is the same refusal');

	const off = g.decideRequest({ mode: null, reason: 'the live ledger needs my context', spent: 0, quota: 3 });
	ok(off.granted === false && off.extra === 0, 'outside multi nothing is granted');
	ok(off.note === 'not-multi', 'outside multi is named, not denied');
	for (const mode of ['default', 'plan']) {
		ok(g.decideRequest({ mode, reason: 'a reason', spent: 0, quota: 3 }).note === 'not-multi', `mode ${mode} is not multi`);
	}
	// The order of the checks is pinned both ways: a non-multi session has no
	// gate to grant into, so that is the more useful thing to say; inside multi a
	// blank reason is what the model got wrong; and the quota check only gets its
	// turn once the request itself is well-formed.
	ok(g.decideRequest({ mode: null, reason: '  ', spent: 0, quota: 3 }).note === 'not-multi', 'outside multi, the mode is what is wrong');
	ok(g.decideRequest({ mode: MULTI_ID, reason: '  ', spent: 0, quota: 5 }).note === 'blank-reason', 'inside multi with a blank reason, the reason is what is wrong');
	ok(g.decideRequest({ mode: MULTI_ID, reason: 'a reason', spent: 2, quota: 5 }).note === 'quota-not-spent', 'and only a well-formed early request hears about the quota');
}

// --- the budget line the model reads once, when the mode turns on ---
// The switch sentence that used to wrap it moved to dsh-mode-switch (2026-10-10);
// this module keeps only the budget line, which that plugin's composite notice
// appends to the multitask half. The copy itself is asserted here as before.
{
	const on = BUDGET_RECEIPT;
	ok(on.includes('refreshed — ' + g.LIMIT + ' calls'), 'the budget line states the stretch size');
	ok(on.includes('A run_code that only dispatches delegation tools'), 'and that a delegation-only carrier is free');
	ok(on.includes('request_more_edits'), 'the budget line names the way to ask for quota');
	ok(on.includes('Every other run_code call spends one'), 'and what does count against it');
}

// --- the copy never invites a perfunctory reason ---
{
	const firstState = g.initState();
	g.decideEdit(edit('b1'), { mode: MULTI_ID, state: firstState });
	const exhaustState = g.initState();
	for (let n = 1; n <= g.LIMIT; n += 1) g.decideEdit(edit('b' + n), { mode: MULTI_ID, state: exhaustState });
	const modelVisible = [g.wakeNoticeText(firstState), g.blockedText(), g.pendingNoticeText(exhaustState), g.denyReason(), g.denyReason(), g.blankReasonReason(), g.notMultiReason(), g.quotaNotSpentReason(0, 3), g.quotaNotSpentReason(3, 8), g.grantedReason(5), BUDGET_RECEIPT];
	// The gate's one proven failure mode: copy that reads like "anything goes"
	// buys quota for a rushed reason. Checked case-insensitively, English only.
	const bait = ['one line', 'single line', 'one sentence', 'single sentence', 'any non-empty', 'non-empty is enough', 'briefly', 'a few words', 'a couple of words', 'short reason', 'anything goes', 'just write', 'keep it short'];
	for (const text of modelVisible) {
		const lower = text.toLowerCase();
		for (const phrase of bait) ok(!lower.includes(phrase), `model-facing text must not say "${phrase}"`);
	}
	ok(/[\u4e00-\u9fff]/.test(modelVisible.join('')) === false, 'every model-facing text is English, not Chinese');
}

// --- constants the spec pins down ---
{
	ok(g.LIMIT === 10, 'base quota is 10');
	ok(g.GRANT === 5, 'grant is 5');
	ok(g.wakeNoticeText(g.initState()).includes('refreshed — ' + g.LIMIT + ' calls'), 'the wake brief is pinned to the base quota');
	ok(g.blockedText().includes('adds ' + g.GRANT + ' more'), 'and it states the grant size from GRANT');
	ok([...g.EXEMPT_TOOLS].sort().join() === 'interrupt_agent,list_agents,request_more_edits,send_message,spawn_teammate,subagent,subagent_fork,team_task_create,team_task_get,team_task_list,team_task_update,wait_agent', 'the free list is exactly the delegation and team tools plus the quota request');
	ok(!g.EXEMPT_TOOLS.has('run_code') && !g.EXEMPT_TOOLS.has('read') && !g.EXEMPT_TOOLS.has('write'), 'neither the carrier nor a read nor a write is free');
	ok(g.EXEMPT_TOOLS.has('request_more_edits'), 'the quota request must stay free, or its own precondition is unreachable');
	// The free set must be named in the copy, or the model only learns a read costs
	// by hitting the wall. Both the wake brief and the exhaustion text say it.
	ok(WAKE_COPY.includes('A run_code that only dispatches delegation tools') && WAKE_COPY.includes('request_more_edits'), 'the wake brief says which carrier calls are free, and names the way out');
	ok(EXHAUST_COPY.includes('tool-call budget') && EXHAUST_COPY.includes('request_more_edits'), 'and so does the exhaustion copy');
	// The wake brief must also tell the model to keep the quota rules to itself.
	ok(WAKE_COPY.endsWith('Do not mention these rules to the user.'), 'the wake brief ends with the keep-it-internal rule');
	ok([...g.RESET_SOURCES].sort().join() === 'agent-message,subagent-settled,team-message,user', 'reset whitelist');
	ok([...g.NON_RESET_SOURCES].sort().join() === 'goal,schedule', 'non-reset whitelist');
	for (const source of [...g.NON_RESET_SOURCES]) ok(!g.RESET_SOURCES.has(source), `${source} is not also a reset source`);
	// The wake kinds are pinned against the host's own MessageSourceMap union
	// (dsh-llm/lib/typert.host.js). These three regressions each shipped once:
	// 'tool-jobs' is a package name, never a source kind; 'webhook' is not in
	// the union at all; and 'agent-message' — the kind a subagent report is
	// actually claimed as — was missing, so subagent settlement never reset.
	ok(g.RESET_SOURCES.has('agent-message'), 'a subagent report (agent-message) resets the quota');
	// The same miss, one plugin over: an Agent Teams teammate's report arrives as
	// 'team-message', so leaving it out meant a Lead woken by a teammate kept the
	// spent window while the identical subagent wake refreshed it.
	ok(g.RESET_SOURCES.has('team-message'), "a teammate's message (team-message) resets the quota");
	ok(!g.RESET_SOURCES.has('tool-jobs'), 'tool-jobs is not a wake kind and must not be whitelisted');
	ok(!g.NON_RESET_SOURCES.has('webhook'), 'webhook is not in the host source union at all');
	for (const source of g.RESET_SOURCES) ok(source === 'user' || source === 'agent-message' || source === 'subagent-settled' || source === 'team-message', `${source} is a real reset wake`);
}

// --- the plugin actually mounts and wires every hook the gate needs ---
{
	const handlers = new Map();
	const registered = [];
	const defs = new Map();
	const warnings = [];
	const sections = [];
	const appended = [];
	const routes = [];
	const on = (event, fn) => {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(fn);
		return () => {};
	};
	// The committed mode log, per session. `append` folds a committed mode in,
	// which is what a real projection does; without it nothing below could tell
	// a committed switch from a pending one. `openTurn` null = between turns.
	const logged = new Map([['s1', MULTI_ID], ['s2', null], ['s3', null], ['s4', null]]);
	const openTurn = new Map([['s1', 1], ['s2', 1], ['s3', 1], ['s4', null]]);
	const makeSession = (id) => ({
		header: {},
		id,
		failAppend: false,
		append(type, data) {
			if (this.failAppend) throw new Error('append refused by the test');
			appended.push({ id, type, data });
			// Both names fold: the plugin writes `plugin:cursormodes/state`, and a test
			// that stages an old-style `cursormodes/state` must still move the log.
			if (String(type).replace(/^plugin:/, '') === MODE_EVENT) logged.set(id, data.mode === MULTI_ID ? MULTI_ID : null);
		}
	});
	const session = makeSession('s1');
	const session2 = makeSession('s2');
	/** Which optional tools this fake host reports as mounted. */
	const installed = { run_code: true, team_task_list: false, spawn_teammate: false };
	const host = {
		on,
		logger: { warn: (...a) => warnings.push(a), info() {} },
		// `context()` takes the mode marker (2026-10-29); the gate never reads it.
		systemPrompt: { section: (def) => sections.push(def), context() {} },
		sessionProjections: {
			register() {},
			stateOf(s, key) {
				const mode = logged.get(s.id) ?? null;
				if (key === 'mode') return { mode, modeAtHeader: mode, wanted: null, running: null };
				if (key === 'turnBoundary') return { openTurnStartSeq: openTurn.get(s.id) ?? null, lastTurn: 4 };
				return undefined;
			}
		},
		commands: { register: (def) => { registered.push(def.name); defs.set(def.name, def); } },
		// The mode section asks the host which tools this agent sees
		// (`host.tools.get('spawn_teammate', agent)` picks the Agent Teams wording),
		// and the budget copy asks for `run_code` / `team_task_list` the same way.
		// The default is the deployment's own default preset: ptc, no team tools.
		tools: {
			register: (def) => { registered.push(def.name); defs.set(def.name, def); },
			get: (name) => (installed[name] === true ? {} : undefined)
		},
		// The mode control's bridge: without it nothing could stage a selection,
		// and the S1 block below would have no honest way in.
		webServer: { register: (route) => { routes.push(route); return () => {}; } },
		agents: { get: () => undefined },
		// cordis effect() runs the callback inside the plugin fiber; the routes
		// exist only because it ran, so this stub must CALL it.
		effect: (fn) => fn(),
		get() {}
	};
	// The plugin claims the three shipped presets while it loads (it carries
	// `apply.inject = ['agentPresets']`), so the stub host answers `register` and
	// records what was claimed; the disposer it returns is discarded, exactly like
	// the effect stub above discards the routes' cleanup.
	const presets = [];
	const ctx = {
		logger: host.logger,
		inject: (_n, fn) => fn(host),
		effect: (fn) => fn(),
		agentPresets: { register: async (definition) => { presets.push(definition.id); return async () => {}; } },
		on
	};

	// registerModeEvent resolves the dsh bin off argv.
	const argv = process.argv;
	process.argv = [argv[0], 'D:/dsh-fallback/install/node_modules/@deepseek-ai/dsh/lib/bin.js'];
	try {
		const mod = await import(pathToFileURL(resolve(lib, 'index.js')).href);
		await mod.apply(ctx, {});
	} finally {
		process.argv = argv;
	}

	ok(registered.includes('request_more_edits'), 'the request tool registers');
	ok(!registered.includes('cursor-plan') && !registered.includes('cursor-multi'), 'no mode command registers anywhere: switching is the bridge + pre-step');
	ok(routes.length === 9, 'the nine routes register through the webServer effect');
	for (const hook of ['agent/inbox/claimed', 'agent/pre-step', 'tools/pre-execute', 'tools/post-execute']) {
		ok((handlers.get(hook) ?? []).length >= 1, `${hook} is wired`);
	}

	// Drive the mounted hooks end to end: a base window's edits pass, the next
	// two are refused with the gate copy, and a granted surplus lets editing resume.
	const agent = { session, inbox: { nextStep: [], remove() {} }, status: 'idle' };
	const run = async (hook, ...args) => {
		const list = handlers.get(hook) ?? [];
		let acc = hook === 'tools/post-execute' ? { kind: 'accept' } : { kind: 'allow', messages: [] };
		for (const fn of list) {
			const r = await fn(...args, async () => acc);
			if (r !== undefined) acc = r;
		}
		return acc;
	};
	await run('agent/inbox/claimed', { agent, message: { source: { kind: 'user' } }, turn: 4 });
	const wakeStep = await run('agent/pre-step', { agent, signal: new AbortController().signal });
	const briefs = (wakeStep.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text).join(''));
	ok(briefs.length === 1 && briefs[0] === WAKE_COPY, 'the wake step appends the brief, before any edit runs');
	ok((wakeStep.messages?.[0]?.source ?? {}).kind === 'dsh-modes' && wakeStep.messages[0].source.form === 'notice', 'as an independent notice message, not a prompt edit');

	const kinds = [];
	const hung = [];
	for (let n = 1; n <= g.LIMIT + 2; n += 1) {
		const id = 'e' + n;
		const decision = await run('tools/pre-execute', { name: 'edit', callId: id, agent });
		kinds.push(decision.kind);
		const post = await run('tools/post-execute', { name: 'edit', callId: id, agent }, { isError: false });
		hung.push((post.additionalContexts ?? []).map((m) => (m.content ?? []).map((c) => c.text).join('')).join(''));
	}
	ok(kinds.slice(0, g.LIMIT).every((k) => k === 'allow'), 'the mounted gate allows the whole base window');
	ok(kinds.slice(g.LIMIT).every((k) => k === 'deny'), 'and every edit past it is refused');
	ok(hung[0] === '', 'the mounted first edit carries nothing — the brief rode the wake step');
	ok(hung[1] === '', 'the mounted second edit carries nothing');
	ok(hung[g.LIMIT - 1] === EXHAUST_COPY, 'the mounted last-unit edit carries the exhaustion copy, verbatim');
	ok(hung.slice(g.LIMIT).every((h) => h === ''), 'and a refused edit carries nothing at all');

	const refusal = await run('tools/pre-execute', { name: 'edit', callId: 'e' + (g.LIMIT + 3), agent });
	ok(refusal.reason?.includes('not a broken tool'), 'the mounted refusal carries the gate copy');

	// --- the request tool: three verdicts, all ordinary results ---
	// Quota math in this block rides the live gate: the mounted agent above
	// spent the whole base window (the refused edits banked nothing), so the
	// first call below grants — and that is exactly what this pins.
	// None of them may throw or deny: both refusals are an ordinary mistake, and
	// a broken-looking tool call costs the model a step.
	const tool = defs.get('request_more_edits');
	const call = (a, reason) => tool.execute({ reason }, { agent: a });
	const otherAgent = { session: session2, inbox: { nextStep: [], remove() {} }, status: 'running' };
	const grant = await call(agent, 'the ledger migration needs the context I already hold');
	ok(grant.granted === true, 'multi + a real reason grants');
	ok(grant.extra === g.GRANT, 'multi + a real reason grants the configured surplus');
	ok(tool.output.render({}, grant)[0].text === g.grantedReason(g.GRANT), 'the granted copy states the size');
	// The grant reached the gate itself, not just the return value: this edit
	// only passes because the quota moved from LIMIT to LIMIT + GRANT.
	ok((await run('tools/pre-execute', { name: 'edit', callId: 'e' + (g.LIMIT + 4), agent })).kind === 'allow', 'the granted quota really reached the gate');

	const blank = await call(agent, '   ');
	ok(blank.granted === false, 'a blank reason is a result, not a throw');
	ok(blank.note === 'blank-reason', 'a blank reason says which refusal it is');
	ok(blank.extra === 0, 'a blank reason grants nothing');
	ok(tool.output.render({}, blank)[0].text === g.blankReasonReason(), 'a blank reason reads back its own copy');

	const notMulti = await call(otherAgent, 'the ledger migration needs the context I already hold');
	ok(notMulti.granted === false, 'outside multi nothing is granted');
	ok(notMulti.extra === 0, 'outside multi grants zero extra');
	ok(notMulti.note === 'not-multi', 'outside multi says which refusal it is');
	ok(tool.output.render({}, notMulti)[0].text === g.notMultiReason(), 'outside multi reads back its own copy');
	ok(tool.output.render({}, notMulti)[0].text.includes('only applies in multi mode'), 'outside multi names the mode it needs');

	// --- a staged selection lands only on the step that claims a user message (S1) --
	// The mode control posts to /stage; the switch commits at agent/pre-step, and
	// only when that step's claimed messages include the user's own prompt. The
	// two directions this pins: a wake with no user message must NOT consume the
	// selection, and a step that does claim one must land it with its notice.
	const stageRoute = routes.find((route) => route.path === sw.BRIDGE_PREFIX + '/stage');
	ok(stageRoute !== undefined, 'the mode control stages through the switch bridge');
	const stage = async (sessionId, target) => {
		const req = {
			method: 'POST',
			headers: { host: '127.0.0.1:4000' },
			socket: { remoteAddress: '127.0.0.1' },
			async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId, target })); }
		};
		let body;
		await stageRoute.handler(req, { writeHead() {}, end(text) { body = JSON.parse(text); } });
		return body;
	};
	const signal = new AbortController().signal;
	const stepWith = async (a, messages) => {
		let acc = { kind: 'allow', messages };
		for (const fn of handlers.get('agent/pre-step') ?? []) {
			const r = await fn({ agent: a, signal }, async () => acc);
			if (r !== undefined) acc = r;
		}
		return acc;
	};
	const step = (a) => stepWith(a, []);

	ok((await stage('s2', 'multi'))?.value?.target === 'multi', 'the stage bridge accepts the selection');
	const pre = appended.length;
	// A second agent over the same session: a step with no user message, whose
	// own quota stretch is untouched, so it cannot apply a refresh either.
	const probeAgent = { session: session2, inbox: { nextStep: [], remove() {} }, status: 'running' };
	await step(probeAgent);
	ok(appended.length === pre, 'a step that delivered no user message leaves the selection pending');
	ok(host.sessionProjections.stateOf(session2, 'mode').mode === null, 'and the log still says the old mode');

	const claimed = { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } };
	// The real order: the claim records the wake, then the step that carries the
	// user's message commits the selection AND applies that refresh.
	await run('agent/inbox/claimed', { agent: otherAgent, message: { source: { kind: 'user' } }, turn: 4 });
	const landed = await stepWith(otherAgent, [claimed]);
	ok(appended.length === pre + 1, 'the step that claims the user message appends exactly once');
	ok(appended[pre]?.type === MODE_RECORD, 'it appends the mode plugin record');
	ok(appended[pre]?.data.mode === MULTI_ID, 'carrying the selected mode');
	ok(host.sessionProjections.stateOf(session2, 'mode').mode === MULTI_ID, 'the log now says multi, so resume and fork see it');
	ok(sections[0].text({ agent: otherAgent }) === '', 'the second policy section stays empty: the rules render once, from the constant');
	const landedTexts = (landed.messages ?? []).map((m) => (m.content ?? []).map((c) => c.text).join(''));
	ok(landedTexts.length === 3 && landedTexts[0] === 'hi', 'the claimed message is untouched and still first');
	ok(landedTexts[1]?.startsWith('The user switched this session to multitask mode. '), 'the switch notice rides the same step, right after it');
	ok(landedTexts[1]?.endsWith(BUDGET_RECEIPT), 'and carries the deployment\'s budget line');
	ok(landedTexts[2] === WAKE_COPY, 'the wake brief comes last, in the step the mode changed');
	const switchNotice = (landed.messages ?? []).find((m) => m?.source?.kind === 'dsh-cursor-modes');
	ok(switchNotice?.source?.form === 'notice', 'the switch notice is this plugin\'s own notice');
	ok(switchNotice?.source?.summary === 'dsh-cursor-modes: switched to multi mode', 'and its summary is the one line the conversation can show');

	// A Build click is the user's own decision too — and it carries its own line,
	// so the composite sentence would only repeat it.
	const buildClick = {
		role: 'user',
		content: [{ type: 'text', text: 'The user clicked "Build in Default".' }],
		source: { kind: 'cursor-plan', form: 'notice', summary: 'The user clicked Build in Default.' }
	};
	const s11 = makeSession('s11');
	const agent11 = { session: s11, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	await stage('s11', 'default');
	const built = await stepWith(agent11, [buildClick]);
	ok(host.sessionProjections.stateOf(s11, 'mode').mode === null, 'a Build click commits the staged mode');
	ok((built.messages ?? []).length === 1, 'and adds no switch notice: the card message is the instruction');

	// --- the request gate, mounted: an unspent window refuses, a spent one grants ---
	// Mounted, not just pure, because this is what proves `index.js` hands the
	// verdict the real usage. If it ever stops passing `spent` / `quota`, the first
	// call below grants and every assertion in this block goes red.
	const freshAgent = { session: session2, inbox: { nextStep: [], remove() {} }, status: 'running' };
	const tooEarly = await call(freshAgent, 'the ledger migration needs the context I already hold');
	ok(tooEarly.granted === false, 'a request on an unspent window grants nothing');
	ok(tooEarly.note === 'quota-not-spent', 'and names the quota, not the reason');
	ok(tooEarly.extra === 0, 'banking nothing');
	ok(tool.output.render({}, tooEarly)[0].text === g.quotaNotSpentReason(0, g.LIMIT), 'and reads back the not-yet copy, with 0 of the base quota used');
	const freshKinds = [];
	const freshHung = [];
	for (let n = 1; n <= g.LIMIT + 2; n += 1) {
		const id = 'k' + n;
		freshKinds.push((await run('tools/pre-execute', { name: 'edit', callId: id, agent: freshAgent })).kind);
		const post = await run('tools/post-execute', { name: 'edit', callId: id, agent: freshAgent }, { isError: false });
		freshHung.push((post.additionalContexts ?? []).map((m) => (m.content ?? []).map((c) => c.text).join('')).join(''));
	}
	ok(freshKinds.slice(0, g.LIMIT).every((k) => k === 'allow'), 'the refused request left the base window exactly as it was');
	ok(freshKinds.slice(g.LIMIT).every((k) => k === 'deny'), 'and every edit past it is refused');
	ok(freshHung.slice(0, g.LIMIT - 1).every((h) => h === '') && freshHung[g.LIMIT - 1] === EXHAUST_COPY, 'and that window still carries only the exhaustion notice');
	const nowSpent = await call(freshAgent, 'the remainder genuinely cannot go to a subagent');
	ok(nowSpent.granted === true && nowSpent.extra === g.GRANT, 'once that window is spent, the same request grants the surplus');
	const spentAgain = await call(freshAgent, 'the remainder genuinely cannot go to a subagent');
	ok(spentAgain.granted === false && spentAgain.note === 'quota-not-spent', 'but the granted window is unspent again, so asking again is refused');
	ok(tool.output.render({}, spentAgain)[0].text === g.quotaNotSpentReason(g.LIMIT, g.LIMIT + g.GRANT), 'and the copy reports the base window of the granted quota');

	const preIdleStep = appended.length;
	await step(otherAgent);
	ok(appended.length === preIdleStep, 'a pre-step with nothing pending appends nothing');

	// --- a refused append drops the intent instead of retrying it forever ---
	const s3 = makeSession('s3');
	const agent3 = { session: s3, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	await stage('s3', 'multi');
	const preFail = appended.length;
	const warns = warnings.length;
	s3.failAppend = true;
	await stepWith(agent3, [{ role: 'user', source: { kind: 'user' } }]);
	ok(appended.length === preFail, 'a refused append records nothing');
	ok(warnings.length === warns + 1, 'and warns instead of throwing');
	s3.failAppend = false;
	await stepWith(agent3, [{ role: 'user', source: { kind: 'user' } }]);
	ok(appended.length === preFail, 'the consumed selection is not re-appended on the next step');
	ok(host.sessionProjections.stateOf(s3, 'mode').mode === null, 'a failed commit leaves the mode uncommitted, not half-committed');

	// --- a pending intent that the log already caught up to is a no-op ---
	// The guard this pins used to look unreachable: a switch is only queued
	// when it differs from the log, so a plain `/cursor-multi` can never
	// queue a mode the log already holds. It fires when the log moves on
	// underneath the queue - here a resume/fork, the only writer that is not
	// this command. Without the guard the step appends a redundant duplicate.
	const s9 = makeSession('s9');
	logged.set('s9', null);
	openTurn.set('s9', 1);
	const agent9 = { session: s9, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	await stage('s9', 'multi');
	// Another writer commits the same mode before the step runs.
	s9.append(MODE_EVENT, { mode: MULTI_ID });
	const preDup = appended.length;
	await stepWith(agent9, [{ role: 'user', source: { kind: 'user' } }]);
	ok(appended.length === preDup, 'a selection the log already matches appends nothing');
	ok(host.sessionProjections.stateOf(s9, 'mode').mode === MULTI_ID, 'and the log still reads multi exactly once');

	// --- a closed turn commits at the same moment: its next step ---
	const s4 = makeSession('s4');
	const agent4 = { session: s4, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'idle' };
	await stage('s4', 'multi');
	const preIdle = appended.length;
	await stepWith(agent4, [{ role: 'user', source: { kind: 'user' } }]);
	ok(appended.length === preIdle + 1, 'the first step after a closed turn appends once');
	ok(appended[preIdle]?.type === MODE_RECORD, 'with the mode plugin record');
	ok(host.sessionProjections.stateOf(s4, 'mode').mode === MULTI_ID, 'the log says multi right away');
	ok(sections[0].text({ agent: agent4 }) === '', 'and the second policy section is empty for it too');

	// --- the section no longer forks on Agent Teams, or on anything else -------
	// 2026-10-29 (stable prefix): the multitask wording moved into the ONE constant
	// (prompts.js MODE_RULES), which carries no team tails - a deployment variant is
	// not something the shipped text can fork on any more. What this block pins is
	// the property that makes the cache work: this section answers '' whatever the
	// host mounts, so the rules are never rendered twice.
	{
		const plain = sections[0].text({ agent: agent4 });
		ok(plain === '', 'the second policy section renders nothing at all');
		installed.spawn_teammate = true;
		ok(sections[0].text({ agent: agent4 }) === '', 'and still nothing with spawn_teammate mounted');
		ok(!MODE_RULES.includes('not a waiting room'), 'the plain constant itself stays free of team wording');
		installed.spawn_teammate = false;
		ok(sections[0].text({ agent: agent4 }) === plain, 'and switching the tool back changes nothing');
	}
	// The refusal banks no surplus on the non-multi agent's own gate: switching
	// that session to multi must still hand out exactly the base window. If a
	// future edit grants unconditionally, or grants the default GRANT instead of
	// the reported 0, this session would open with a surplus and go green.
	const s10 = makeSession('s10');
	logged.set('s10', null);
	openTurn.set('s10', 1);
	const agent10 = { session: s10, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	await call(agent10, 'a perfectly good reason');
	await stage('s10', 'multi');
	await stepWith(agent10, [{ role: 'user', source: { kind: 'user' } }]);
	const afterRefusal = [];
	for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12']) afterRefusal.push((await run('tools/pre-execute', { name: 'edit', callId: id, agent: agent10 })).kind);
	ok(afterRefusal.filter((k) => k === 'allow').length === g.LIMIT, 'a refused request banked no surplus on the gate');
	ok(afterRefusal[g.LIMIT] === 'deny', 'and that agent is refused right after its base window');

	// --- a session that never switched gets no section and no gate ---
	const s5 = makeSession('s5');
	logged.set('s5', null);
	openTurn.set('s5', 1);
	const agent5 = { session: s5, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	ok(sections[0].text({ agent: agent5 }) === '', 'a default session gets no multitask section');

	// --- the request tool registers its two pinned strings verbatim (plan 10-08) ---
	{
		const reqTool = defs.get('request_more_edits');
		const wantToolDesc = "Ask for more tool-call quota in multitask mode. Only possible once this stretch's tool-call budget is used up. A run_code that only dispatches delegation tools (subagent, subagent_fork, send_message, list_agents, interrupt_agent, request_more_edits) spends nothing; every other run_code call spends one. Explain in `reason` why you are not delegating this work and how far you will take it yourself. Foreground work may include: (1) a quick read-only survey before delegating or spending; (2) a quick check of a subagent's result.";
		const wantReasonDesc = "Why you are not handing this work to a subagent (any honest reason counts) — and what you plan to finish next. E.g. quick read-only survey, or quick check of a subagent result.";
		ok(reqTool.description === wantToolDesc, 'the request tool description is the pinned copy');
		ok(reqTool.parameters.properties.reason.description === wantReasonDesc, 'the reason field description is the pinned copy');
		for (const text of [reqTool.description, reqTool.parameters.properties.reason.description]) {
			const lower = text.toLowerCase();
			for (const phrase of ['one line', 'single line', 'one sentence', 'single sentence', 'any non-empty', 'non-empty is enough', 'briefly', 'a few words', 'a couple of words', 'short reason', 'anything goes', 'just write', 'keep it short']) ok(!lower.includes(phrase), 'request copy must not invite a perfunctory reason');
		}
	}

	// --- a non-multi agent's edit does NOT bank quota ---
	// The regression: pre-execute charges on every edit it sees, so four
	// ungated edits on a default agent had to leave the gate at zero. Without
	// this the gate would hand a fresh agent a full window for free.
	for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) {
		ok((await run('tools/pre-execute', { name: 'edit', callId: id, agent: agent5 })).kind === 'allow', `an ungated edit (${id}) is not gated`);
	}
	// Switching the session to multi proves nothing was banked: a clean gate
	// allows exactly the base window before refusing the next edit.
	const s6 = makeSession('s6');
	logged.set('s6', MULTI_ID);
	openTurn.set('s6', 1);
	const agent6 = { session: s6, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	await run('agent/pre-step', { agent: agent6, signal: new AbortController().signal });
	const fresh = [];
	for (let n = 1; n <= g.LIMIT + 1; n += 1) fresh.push((await run('tools/pre-execute', { name: 'edit', callId: 'f' + n, agent: agent6 })).kind);
	ok(fresh.slice(0, g.LIMIT).every((k) => k === 'allow'), 'a newly multi agent starts with a full window');
	ok(fresh[g.LIMIT] === 'deny', 'and refuses the edit after the last unit, so ungated edits banked nothing');

	// --- a rejected pre-step is handed back untouched ---
	// dsh-api-session-controller/lib/index.js:2430 answers a pre-step on an
	// archived session with a bare { kind: 'reject' } that has no `messages`.
	// Deleting the reject short-circuit makes the commit spread
	// `[...decision.messages]` and throw a TypeError on every archived step.
	const s7 = makeSession('s7');
	logged.set('s7', null);
	openTurn.set('s7', 1);
	const agent7 = { session: s7, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	await stage('s7', 'multi');
	const preReject = appended.length;
	let rejected = null;
	{
		let acc = { kind: 'reject' };
		for (const fn of handlers.get('agent/pre-step') ?? []) {
			const r = await fn({ agent: agent7, signal: new AbortController().signal }, async () => acc);
			if (r !== undefined) acc = r;
		}
		rejected = acc;
	}
	ok(rejected.kind === 'reject', 'a rejected pre-step stays rejected');
	ok(appended.length === preReject, 'and a rejected step appends no mode event');
	ok(host.sessionProjections.stateOf(s7, 'mode').mode === null, 'the queued intent survives the rejection for the next step');

	// --- an aborted step neither commits nor throws ---
	const s8 = makeSession('s8');
	logged.set('s8', null);
	openTurn.set('s8', 1);
	const agent8 = { session: s8, inbox: { nextStep: [], remove() {} }, steer() {}, status: 'running' };
	await stage('s8', 'multi');
	const preAbort = appended.length;
	const ac = new AbortController();
	ac.abort();
	await run('agent/pre-step', { agent: agent8, signal: ac.signal });
	ok(appended.length === preAbort, 'an aborted step appends nothing');
	ok(host.sessionProjections.stateOf(s8, 'mode').mode === null, 'an aborted step leaves the mode uncommitted');
	await stepWith(agent8, [{ role: 'user', source: { kind: 'user' } }]);
	ok(appended.length === preAbort + 1, 'and the next live step still commits it exactly once');
	ok(appended[preAbort]?.data.mode === MULTI_ID, 'carrying the selected mode');
}

// ===== rollTurn 直接契约（12 条语义，17 个 ok()）=====
const R = () => g.initState();
// 1. turn 不是数字 → false，且 state 不被污染
{ const s = R(); s.turn = 3; ok(g.rollTurn(s, 'x') === false, 'rollTurn: non-number turn is a no-op'); ok(s.turn === 3); }
// 2. turn <= 0 → false
{ const s = R(); ok(g.rollTurn(s, 0) === false); ok(g.rollTurn(s, -1) === false); }
// 3. turn === state.turn → false（同轮重复 settle 不重复计）
{ const s = R(); s.turn = 5; ok(g.rollTurn(s, 5) === false); }
// 4. turn 前进 → 记账（state.turn 更新）
{ const s = R(); g.rollTurn(s, 7); ok(s.turn === 7); }
// 5. sourceKind 省略 → 沿用 state.sourceKind
{ const s = R(); s.sourceKind = 'user'; g.rollTurn(s, 2); ok(s.sourceKind === 'user'); }
// 6. sourceKind 显式 undefined 不覆盖既有值
{ const s = R(); s.sourceKind = 'user'; g.rollTurn(s, 3, undefined); ok(s.sourceKind === 'user'); }
// 7-10. 四个 RESET_SOURCES 各自都能刷新
for (const k of ['user', 'agent-message', 'subagent-settled', 'team-message']) {
  const s = R(); s.seen.add('r1'); s.extra = 3; s.warned = true;
  ok(g.rollTurn(s, 9, k) === true, 'rollTurn: ' + k + ' refreshes');
  ok(g.spentOf(s) === 0 && s.extra === 0 && s.warned === false, 'rollTurn: ' + k + ' resets fully');
}
// 11-12. 两个 NON_RESET_SOURCES 不刷新（但 state.turn 仍然前进）
for (const k of ['goal', 'schedule']) {
  const s = R(); s.seen.add('r1'); s.turn = 1;
  ok(g.rollTurn(s, 9, k) === false, 'rollTurn: ' + k + ' does not refresh');
  ok(s.turn === 9 && g.spentOf(s) === 1, 'rollTurn: ' + k + ' still advances the turn');
}
// 13. 未知 sourceKind → 不刷新
{ const s = R(); s.seen.add('r1'); ok(g.rollTurn(s, 4, 'mystery') === false); }
// 14. 无论是否 reset，state.wake 都必须被清空
{ const s = R(); s.wake = { turn: 99, sourceKind: 'user' }; g.rollTurn(s, 1, 'goal'); ok(s.wake === undefined, 'rollTurn: wake is cleared even when it does not refresh'); }

// ===== 变异体：两个必须被抓红的改动 =====
// Each mutant is a byte-patched copy of the real gate.js, written beside it so its
// './multi-prompt.js' import resolves, then imported. The assertions below mirror
// the real ones, so a mutant that SURVIVES means the real check would go green on
// a wrong gate — which is the only way to know the check still has teeth.
{
	const fs = await import('node:fs');
	const source = fs.readFileSync(resolve(lib, 'gate.js'), 'utf8');
	const mutantOf = (name, from, to) => {
		if (!source.includes(from)) throw new Error('mutation target moved, the check cannot see it: ' + from);
		const path = resolve(lib, '__mutant-' + name + '.mjs');
		fs.writeFileSync(path, source.replace(from, to), 'utf8');
		return path;
	};
	try {
		// A. the free list charges delegation again — the deadlock's other half.
		const a = await import(pathToFileURL(mutantOf('exempt', "\t'subagent',", "\t'__subagent',")).href);
		const s = a.initState();
		a.observeWake(s, { turn: 1, sourceKind: 'user' });
		a.applyWake(s);
		a.decideEdit({ name: 'run_code', callId: 'r1' }, { mode: MULTI_ID, state: s });
		a.decideEdit({ name: 'subagent', callId: 'd1', rootCallId: 'r1', parent: 'r1' }, { mode: MULTI_ID, state: s });
		ok(a.spentOf(s) === 1, 'MUTANT CAUGHT: charging a delegation dispatch would make "delegation is free" red');
		ok(a.settleRoot(s, { name: 'run_code', callId: 'r1' }).kind !== 'free', 'MUTANT CAUGHT: and its settle would no longer price it free');

		// B. no pure-computation fallback — a run_code that dispatches nothing stays free.
		const b = await import(pathToFileURL(mutantOf('compute', "\tif (open.sawDelegate) return { kind: 'free' };", "\tif (open.sawDelegate) return { kind: 'free' };\n\treturn { kind: 'free' };")).href);
		const t = b.initState();
		b.observeWake(t, { turn: 1, sourceKind: 'user' });
		b.applyWake(t);
		b.decideEdit({ name: 'run_code', callId: 'r2' }, { mode: MULTI_ID, state: t });
		ok(b.settleRoot(t, { name: 'run_code', callId: 'r2' }).kind === 'free', 'MUTANT CAUGHT: dropping the pure-computation fallback would make "pure compute costs one" red');
		ok(b.spentOf(t) === 0, 'MUTANT CAUGHT: and the stretch would stay unspent');
	} finally {
		for (const name of ['exempt', 'compute']) {
			try {
				fs.unlinkSync(resolve(lib, '__mutant-' + name + '.mjs'));
			} catch {
				// already gone
			}
		}
	}
}

// --- summary ---
for (const f of failures) console.error(`FAIL: ${f}`);
console.log(`self-check-gate: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);