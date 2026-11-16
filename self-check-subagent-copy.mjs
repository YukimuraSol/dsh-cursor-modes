#!/usr/bin/env node
// self-check-subagent-copy.mjs — the session-header subagent chip copy: does the
// plugin still notice that a child is RUNNING?
//
// 0.2.2 moved the running state out of the chip's aria-label. The button now
// carries the TOTAL there ("283 个子智能体"), and "a child is running" is
// structural: an ongoing StateDot inside the chip ('svg[data-state="ongoing"]')
// plus an aria-describedby pointing at a hidden span that holds the RUNNING
// count. The plugin used to read the wording, so it silently fell back to
// "累计 283 个子智能体" while three children were running.
//
// So the assertion that has to exist is exactly this one: a chip whose aria
// label says plain "283 个子智能体" and which carries the spinner MUST read as
// running. It is written against the SHIPPED region, sliced out of the bundle
// and evaluated in Node with a stub DOM, so it cannot drift from the code it
// checks, and it goes red on the old build:
//
//   node self-check-subagent-copy.mjs                                 # green
//   node self-check-subagent-copy.mjs lib/client.js.bak-subagentcopy-20261113   # red
//
// Eight scenarios, one line each. No framework, no browser.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, process.argv[2] ?? join('lib', 'client.js'));
const source = readFileSync(target, 'utf8');
const regionStart = source.indexOf('//#region dsh-cursor-modes/subagent-copy');
const regionEnd = source.indexOf('//#endregion', regionStart);
if (regionStart < 0 || regionEnd < 0) throw new Error('subagent-copy region not found in ' + target);
const region = source.slice(regionStart, regionEnd);

// ---------------------------------------------------------------- stub DOM ---
// Only what the region touches: attributes, closest, querySelector, a text
// walker, getElementById, and a MutationObserver that records nothing.

const SHOW_TEXT = 4;

class StubText {
	constructor(value) { this.nodeType = 3; this.parentElement = null; this.writes = 0; this._value = value; }
	get nodeValue() { return this._value; }
	set nodeValue(next) { this.writes += 1; this._value = next; }
}

class StubElement {
	constructor(tag, attrs = {}) {
		this.nodeType = 1;
		this.tagName = tag.toUpperCase();
		this.attrs = { ...attrs };
		this.childNodes = [];
		this.parentElement = null;
	}
	get nodeValue() { return null; }
	get textContent() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); }
	getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
	setAttribute(name, value) { this.attrs[name] = String(value); }
	removeAttribute(name) { delete this.attrs[name]; }
	appendChild(child) { child.parentElement = this; this.childNodes.push(child); return child; }
	removeChild(child) {
		const i = this.childNodes.indexOf(child);
		if (i >= 0) this.childNodes.splice(i, 1);
		child.parentElement = null;
		return child;
	}
	matches(selector) { return selector.split(',').some((part) => matchesSimple(this, part.trim())); }
	closest(selector) {
		let node = this;
		while (node) {
			if (node.nodeType === 1 && node.matches(selector)) return node;
			node = node.parentElement;
		}
		return null;
	}
	querySelector(selector) {
		for (const child of this.childNodes) {
			if (child.nodeType !== 1) continue;
			if (child.matches(selector)) return child;
			const inner = child.querySelector(selector);
			if (inner) return inner;
		}
		return null;
	}
}

/** 'tag' / '[attr]' / '[attr="value"]' / 'tag[attr]', one compound selector. */
function matchesSimple(el, part) {
	const shape = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/.exec(part);
	if (!shape) return false;
	if (shape[1] && el.tagName !== shape[1].toUpperCase()) return false;
	for (const raw of shape[2] ? shape[2].match(/\[[^\]]+\]/g) : []) {
		const inner = raw.slice(1, -1);
		const eq = inner.indexOf('=');
		if (eq < 0) { if (el.getAttribute(inner.trim()) === null) return false; continue; }
		const name = inner.slice(0, eq).trim();
		const value = inner.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
		if (el.getAttribute(name) !== value) return false;
	}
	return true;
}

function findById(root, id) {
	if (!root) return null;
	if (root.nodeType === 1 && root.getAttribute('id') === id) return root;
	for (const child of root.childNodes ?? []) {
		const hit = child.nodeType === 1 ? findById(child, id) : null;
		if (hit) return hit;
	}
	return null;
}

const document = {
	body: null,
	getElementById: (id) => findById(document.body, id),
	createTreeWalker(root) {
		const texts = [];
		const walk = (node) => { for (const child of node.childNodes) { if (child.nodeType === 3) texts.push(child); else walk(child); } };
		walk(root);
		let i = -1;
		return { nextNode() { i += 1; return i < texts.length ? texts[i] : null; } };
	}
};

let observerCallback = null;
class MutationObserver {
	constructor(callback) { observerCallback = callback; }
	observe() {}
	disconnect() {}
}

const api = new Function('document', 'NodeFilter', 'MutationObserver', region + '\nreturn { rewriteSubagentCopy, mountSubagentCopy };')(
	document, { SHOW_TEXT }, MutationObserver
);

// -------------------------------------------------------------- the chip ----

/**
 * The 0.2.2 chip: wrapper [data-subagent-action] > button[aria-label = TOTAL] >
 * (activity slot: users icon [+ ongoing StateDot]) + span[data-subagent-count] >
 * text; and, only while something runs, a SIBLING span#activity[hidden] holding
 * the running count.
 */
function buildChip({ total, running, runningCount, withDot = true, withActivity = true, legacyAria = false }) {
	document.body = new StubElement('div', {});
	const wrap = new StubElement('div', { 'data-subagent-action': '' });
	const button = new StubElement('button', { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
	const slot = new StubElement('span', { 'aria-hidden': 'true' });
	slot.appendChild(new StubElement('svg', {}));
	if (running && withDot) slot.appendChild(new StubElement('svg', { 'data-state': 'ongoing' }));
	button.appendChild(slot);
	const count = new StubElement('span', { 'data-subagent-count': '' });
	const countText = new StubText(total + ' 个子智能体');
	count.appendChild(countText);
	button.appendChild(count);
	button.setAttribute('aria-label', legacyAria ? runningCount + ' 个子智能体，正在运行' : total + ' 个子智能体');
	wrap.appendChild(button);
	let activity = null;
	let activityText = null;
	if (running && withActivity) {
		button.setAttribute('aria-describedby', 'activity');
		activity = new StubElement('span', { id: 'activity', hidden: '' });
		activityText = new StubText(runningCount + ' 个子智能体，正在运行');
		activity.appendChild(activityText);
		wrap.appendChild(activity);
	}
	document.body.appendChild(wrap);
	return { wrap, button, slot, count, countText, activity, activityText };
}

/** Mount on the chip as it is, and hand back the observer's own dispatch seam. */
function mount() {
	api.mountSubagentCopy();
	return {
		childList(target, addedNodes = []) { observerCallback([{ type: 'childList', target, addedNodes }]); },
		text(target) { observerCallback([{ type: 'characterData', target, addedNodes: [] }]); },
		attribute(target) { observerCallback([{ type: 'attributes', target, addedNodes: [] }]); }
	};
}

// ------------------------------------------------------------- assertions ---

let passed = 0;
const failures = [];
function ok(condition, label, detail) {
	if (condition) {
		passed += 1;
		console.log('ok   ' + label);
	} else {
		failures.push(label + (detail === undefined ? '' : ' (' + detail + ')'));
		console.log('FAIL ' + label + (detail === undefined ? '' : ' (' + detail + ')'));
	}
}

// 1. THE REGRESSION. The aria label says the total and no Chinese word anywhere says
//    "running"; the spinner and the described-by span do. That has to read as running.
{
	const chip = buildChip({ total: 283, running: true, runningCount: 3 });
	mount();
	ok(chip.countText.nodeValue === '3 个子智能体正在运行', 'running chip: spinner + described-by decide it, not the wording', JSON.stringify(chip.countText.nodeValue));
}

// 2. Idle: the plain total, announced as an accumulation.
{
	const chip = buildChip({ total: 283, running: false });
	mount();
	ok(chip.countText.nodeValue === '累计 283 个子智能体', 'idle chip: total, announced as accumulated', JSON.stringify(chip.countText.nodeValue));
}

// 3. Run ends. The StateDot, the aria-describedby and the described-by span all go
//    away in one commit, and the removal is recorded on the WRAPPER, not on the
//    button - the case that used to leave "正在运行" behind.
{
	const chip = buildChip({ total: 2, running: true, runningCount: 2 });
	const watch = mount();
	chip.slot.removeChild(chip.slot.childNodes[1]);
	chip.button.removeAttribute('aria-describedby');
	chip.wrap.removeChild(chip.activity);
	watch.childList(chip.wrap);
	ok(chip.countText.nodeValue === '累计 2 个子智能体', 'run ends: falls back to the total, no residue', JSON.stringify(chip.countText.nodeValue));
}

// 4. The running count can change while the chip stays running (one child finished,
//    one still runs). DSH updates only its hidden described-by span, so the visible
//    number has to follow that text change.
{
	const chip = buildChip({ total: 2, running: true, runningCount: 2 });
	const watch = mount();
	chip.activityText.nodeValue = '1 个子智能体，正在运行';
	watch.text(chip.activityText);
	ok(chip.countText.nodeValue === '1 个子智能体正在运行', 'running count 2->1 follows the described-by span', JSON.stringify(chip.countText.nodeValue));
}

// 5. DSH's own aria description is not ours: the hidden span keeps the exact text
//    DSH rendered for it, punctuation included.
{
	const chip = buildChip({ total: 2, running: true, runningCount: 2 });
	mount();
	ok(chip.activityText.nodeValue === '2 个子智能体，正在运行', 'the hidden accessible copy is never rewritten', JSON.stringify(chip.activityText.nodeValue));
}

// 6. Idempotent and quiet: re-reading its own output writes nothing more, which is
//    what keeps the MutationObserver from chasing itself.
{
	const chip = buildChip({ total: 283, running: true, runningCount: 3 });
	const watch = mount();
	const after = chip.countText.writes;
	watch.text(chip.countText.nodeValue === undefined ? chip.count : chip.count.childNodes[0]);
	api.rewriteSubagentCopy(document.body);
	api.rewriteSubagentCopy(document.body);
	ok(chip.countText.writes === after && chip.countText.nodeValue === '3 个子智能体正在运行', 'idempotent: no rewrite loop, no second write', 'writes=' + chip.countText.writes);
}

// 7. Either structural tell alone is enough: a DSH that keeps the described-by span
//    but drops the dot still reads as running.
{
	const chip = buildChip({ total: 12, running: true, runningCount: 2, withDot: false });
	mount();
	ok(chip.countText.nodeValue === '2 个子智能体正在运行', 'described-by span alone is enough', JSON.stringify(chip.countText.nodeValue));
}

// 8. Last resort still holds: an older chip whose aria label IS the running copy
//    (0.2.1), with neither structural tell.
{
	const chip = buildChip({ total: 41, running: true, runningCount: 5, withDot: false, withActivity: false, legacyAria: true });
	mount();
	ok(chip.countText.nodeValue === '5 个子智能体正在运行', 'legacy running aria still recognised', JSON.stringify(chip.countText.nodeValue));
}

console.log('');
console.log(target + ': ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) {
	for (const failure of failures) console.log('  - ' + failure);
	process.exit(1);
}
