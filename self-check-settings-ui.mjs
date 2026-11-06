#!/usr/bin/env node
// self-check-settings-ui.mjs — the delegation-gate card's UI, asserted by rendering
// the real lib/client.js with a fake React (the same trick self-check-bridge uses),
// plus the en/zh mirror the card's copy lives in.
//
// Why render instead of calling a helper: the things this file exists to pin are
// facts about the tree the user sees — two separate branches, which fields each
// branch carries, where the JEV connection lives, that the key box is always empty
// and masked — not about a value some function returns. The address rule and the
// request a blur sends are the exceptions: both are behaviour, so they are driven.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
function ok(cond, label) {
	if (cond) passed++;
	else failures.push(label);
}
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a === b) passed++;
	else failures.push(label + ' — got ' + a + ', want ' + b);
}

// ===========================================================================
// Load the client bundle the way the page does.
// ===========================================================================
const loaded = {};
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded.spec = spec; } } };
new Function('window', 'document', readFileSync(resolve(here, 'lib', 'client.js'), 'utf8'))(globalThis.window, undefined);
if (loaded.spec === undefined) {
	console.error('FAILED: lib/client.js never called window.__ModuleLoader__.load');
	process.exit(1);
}

/**
 * The card's state, injected through the fake hooks: the real component runs, the
 * real render happens, only the round trip to the host is replaced. Leaving
 * advanced undefined means "let the component's own default stand" — which is how
 * the collapsed disclosure is observed rather than asserted from a literal.
 */
const screen = { view: undefined, draft: undefined, error: undefined, busy: undefined, advanced: undefined, keyReveal: undefined };
let hookIndex = 0;
const react = {
	createElement: (type, props, ...children) => ({
		type,
		props: props ?? {},
		children: children.flat().filter((child) => child !== null && child !== undefined && child !== false && child !== true)
	}),
	Fragment: { fragment: true },
	// Six slots, in the component's own order: view, draft, error, busy,
	// advancedOpen, keyReveal.
	useState: (value) => {
		const slot = hookIndex++;
		const injected = [screen.view, screen.draft, screen.error, screen.busy, screen.advanced, screen.keyReveal][slot];
		return [injected === undefined ? value : injected, () => {}];
	},
	useRef: (value) => ({ current: value }),
	useEffect: () => {},
	memo: (component) => component
};
const primitives = { MarkdownText: () => null, Menu: () => null, IconChevronDownOutlineRegular: () => null };
const client = loaded.spec.factory((name) => {
	if (name === 'react') return react;
	if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
	throw new Error('the client asked for an unexpected module: ' + name);
});

let dicts = null;
const seats = [];
client.apply({
	effect: (body) => { body(); return () => {}; },
	locale: {
		register: (namespace, dictionaries) => { dicts = dictionaries; return () => {}; },
		bind: () => (key) => key
	},
	uiConversation: { events: { register: () => () => {} } },
	slots: {
		inject: (name, callback) => callback(),
		register: (options, component) => { seats.push({ options, component }); return () => {}; }
	}
});

const tab = seats.find((seat) => seat.options.name === 'settings.plugins.tab');
if (tab === undefined) {
	console.error('FAILED: the client never registered a settings.plugins.tab card');
	process.exit(1);
}
const t = (key) => dicts.zh[key] ?? key;
const te = (key) => dicts.en[key] ?? key;
/** Backtick, without writing one into this file. */
const BT = String.fromCharCode(96);
const helpers = client.gateCardHelpers;
if (helpers === undefined) {
	console.error('FAILED: lib/client.js exports no gateCardHelpers');
	process.exit(1);
}

// ===========================================================================
// Tree helpers.
// ===========================================================================
function nodes(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	out.push(node);
	for (const child of node.children ?? []) nodes(child, out);
	return out;
}
const all = (tree, predicate) => nodes(tree).filter(predicate);
function texts(node, out = []) {
	if (typeof node === 'string') { out.push(node); return out; }
	if (node === null || node === undefined || typeof node !== 'object') return out;
	for (const child of node.children ?? []) texts(child, out);
	return out;
}
function textOf(node) {
	return texts(node).join('');
}
const hasClass = (node, name) => String(node?.props?.className ?? '').trim().split(/\s+/).includes(name);
const buttons = (tree) => all(tree, (node) => node.type === 'button');
const inputs = (tree) => all(tree, (node) => node.type === 'input');
/** Every row of the card, in document order. */
const rows = (tree) => all(tree, (node) => hasClass(node, 'Cp8sVz_row'));
/** The row whose text starts with a label — map-key-free, so a rename shows up here. */
const rowByLabel = (tree, label) => rows(tree).find((row) => textOf(row).startsWith(label));
/** Every quiet line under a row label. */
const hintsIn = (node) => all(node, (child) => hasClass(child, 'Cp8sVz_hint'));
/** The advanced disclosure's own body, whichever branch shaped it. */
const advancedBox = (tree) => all(tree, (node) => hasClass(node, 'Cp8sVz_fields') || hasClass(node, 'Cp8sVz_grid'))[0];
const advancedInputs = (tree) => {
	const box = advancedBox(tree);
	return box === undefined ? [] : all(box, (node) => node.type === 'input');
};
/** The connection group's caption, above its three rows. */
const connectionHead = (tree) => all(tree, (node) => hasClass(node, 'Cp8sVz_groupHead'))[0];
/** Document order of the inputs and the segmented control. */
function order(tree) {
	const out = [];
	const walk = (node) => {
		if (typeof node === 'string') { out.push(node); return; }
		if (node === null || node === undefined || typeof node !== 'object') return;
		if (node.type === 'select') out.push('<select>');
		if (node.type === 'input') out.push('<input>');
		if (node.props?.role === 'group') out.push('<seg>');
		for (const child of node.children ?? []) walk(child);
	};
	walk(tree);
	return out;
}
/** Input labels, in document order: what this branch actually lets you edit. */
const inputLabels = (tree) => inputs(tree).map((node) => node.props['aria-label']);

// ===========================================================================
// The two branches' host state.
// ===========================================================================
const GATEWAY = 'http://127.0.0.1:7899/api/v1';
const JEV_VALUES = {
	enabled: true,
	backend: 'jev',
	model: '',
	baseUrl: GATEWAY,
	timeoutMs: 10000,
	allowConfidence: 0.8,
	workReject: 0.5,
	apiKeyRef: 'OPENROUTER_API_KEY'
};
/** The host answer: the effective values, and one boolean about the key. */
function viewWith({ apiKeyConfigured = false } = {}) {
	return { values: { ...JEV_VALUES }, apiKeyConfigured, status: null };
}
/** The follow-the-session branch: the shipped default, and the design's own state. */
const FOLLOW = { backend: 'llm', model: '' };
/** The draft the boxes render; the key is always seeded empty by the card. */
const draftWith = (patch = {}) => ({ ...JEV_VALUES, apiKey: '', ...patch });

/** One render; the whole screen state lives in screen, so each block states only what it changes. */
function render(patch = {}) {
	Object.assign(screen, { view: viewWith(), draft: draftWith(FOLLOW), error: null, busy: false, advanced: undefined, keyReveal: false }, patch);
	hookIndex = 0;
	return tab.component({ t });
}

/** A recorded bridge call, so "this blur wrote nothing" is a fact about the wire. */
const posts = [];
globalThis.fetch = async (url, init) => {
	posts.push({ url, body: init?.body === undefined ? null : JSON.parse(init.body) });
	return {
		json: async () => ({ ok: true, value: { ...JEV_VALUES }, apiKeyConfigured: true, credential: null })
	};
};
const settle = () => new Promise((done) => setTimeout(done, 5));
/** The key box: the only password input the card can render. */
const keyBox = (tree) => inputs(tree).find((node) => node.props.type === 'password');

// ===========================================================================
// 1. The first row: title, the sentence with its inline code, one switch.
// ===========================================================================
{
	const tree = render({ view: viewWith(), draft: draftWith(FOLLOW) });
	const switches = all(tree, (node) => node.props?.role === 'switch');
	eq(switches.length, 1, 'the card carries exactly one switch');
	eq(switches[0].props['aria-label'], '委派门禁', 'and that switch is labelled 委派门禁');
	eq(switches[0].props['aria-checked'], true, 'on, because the stored gate is enabled');
	eq(texts(switches[0]).length, 0, 'the design draws the switch bare: its state is the knob, not a word');
	eq(all(switches[0], (node) => hasClass(node, 'Cp8sVz_knob')).length, 1, 'the knob is its own element, so the track can animate it');
	ok(texts(tree).includes('委派门禁'), 'the card title reads 委派门禁');
	eq(dicts.zh['settings.title'], '委派门禁', 'the Chinese card title is 委派门禁');
	eq(dicts.en['settings.title'], 'Delegation gate', 'the English card title says the same thing');
	const codes = all(tree, (node) => node.type === 'code');
	eq(codes.map(textOf), ['subagent', 'send_message'], 'the two gated tools are inline code, in sentence order');
	ok(textOf(tree).includes('都先交给判官判定'), 'the description carries the design sentence');
	ok(textOf(tree).includes('改动即时生效'), 'including the applies-immediately clause');
	const head = rowByLabel(tree, '委派门禁');
	ok(head !== undefined, 'the header is one row of the card');
	ok(nodes(head).includes(switches[0]), 'and the switch sits inside that row');
	ok(hasClass(head, 'Cp8sVz_rowTop'), 'aligned to the top of it, so the 3-line sentence does not push it to the middle');
	// The card is one sheet with one silhouette: no nested floating cards.
	const sheet = all(tree, (node) => hasClass(node, 'Cp8sVz_card'));
	eq(sheet.length, 1, 'the whole card is one sheet');
	eq(hasClass(tree, 'Cp8sVz_card'), true, 'and the section itself is it');
	eq(texts(tree).filter((line) => line === '委派门禁').length, 1, 'the title appears once: the row is not repeated as a heading');
}

// ===========================================================================
// 2. 判官来源: one segmented control, and both sources are always pickable.
// ===========================================================================
{
	const follow = render({ draft: draftWith(FOLLOW) });
	const groups = all(follow, (node) => node.props?.role === 'group');
	eq(groups.length, 1, 'one segmented control, not two');
	eq(groups[0].props['aria-label'], '判官来源', 'labelled 判官来源');
	const segButtons = buttons(groups[0]);
	eq(segButtons.map(textOf), ['跟随当前模型', 'JEV 专用判官'], 'the two sources, follow first');
	eq(segButtons.map((node) => node.props['aria-pressed']), [true, false], 'follow is the pressed one');
	const jev = render({ draft: draftWith({ backend: 'jev' }) });
	const jevButtons = buttons(all(jev, (node) => node.props?.role === 'group')[0]);
	eq(jevButtons.map((node) => node.props['aria-pressed']), [false, true], 'and JEV is pressed when that is the stored backend');
	// The JEV branch is where its connection is entered, so it cannot require the
	// connection to already exist: both options are always enabled.
	eq(jevButtons.map((node) => node.props.disabled), [false, false], 'neither source is ever disabled, even with no key stored');
	eq(segButtons.map((node) => node.props.disabled), [false, false], 'not on the follow branch either');
	eq(buttons(groups[0]).length, 2, 'exactly two options: no third mode crept in');
	eq(all(follow, (node) => hasClass(node, 'Cp8sVz_greyed')).length, 0, 'the old greyed-out state is gone with the credential badge');
	// The source row is a label and the control, nothing else: the caption sentence
	// that used to sit under it is one of the deleted elements.
	const sourceRow = rowByLabel(follow, '判官来源');
	eq(textOf(sourceRow), '判官来源跟随当前模型JEV 专用判官', 'the source row carries the label and the two options, with no hint sentence and no model name');
	eq(hintsIn(sourceRow).length, 0, 'no hint line under the control');
}

// ===========================================================================
// 3. Branch A (跟随当前模型): a fixed model row, and the timeout alone.
// ===========================================================================
{
	const tree = render({ draft: draftWith(FOLLOW), advanced: false });
	ok(textOf(tree).includes('判官模型'), 'the branch states its judge model');
	const modelRow = rowByLabel(tree, '判官模型');
	ok(modelRow !== undefined, 'in a row of its own');
	eq(all(modelRow, (node) => node.type === 'select').length, 0, 'which is not a select: there is nothing to choose on this branch');
	eq(all(modelRow, (node) => node.type === 'input').length, 0, 'and not a text box either');
	ok(texts(modelRow).includes('跟随当前会话模型'), 'it reads 跟随当前会话模型');
	ok(texts(modelRow).includes('▾'), 'with the design chevron, so it reads as the one fixed value');
	ok(hasClass(all(modelRow, (node) => hasClass(node, 'Cp8sVz_selectRow'))[0], 'Cp8sVz_selectFixed'), 'drawn in the control box, marked as fixed rather than interactive');
	// The connection belongs to JEV; the follow branch has none of it.
	ok(!textOf(tree).includes('连接'), 'no 连接 caption on the follow branch');
	ok(!textOf(tree).includes('模型 ID'), 'no model id row');
	ok(!textOf(tree).includes('API 地址'), 'no endpoint row');
	ok(!textOf(tree).includes('密钥'), 'no key row');
	eq(inputLabels(tree), [], 'so the follow branch has no editable field while the disclosure is shut');
	// One threshold is not a threshold: the pair is JEV-only.
	const open = render({ draft: draftWith(FOLLOW), advanced: true });
	eq(inputLabels(open), ['判官超时（毫秒）'], 'opened, the follow branch edits the timeout and nothing else');
	eq(advancedInputs(open).length, 1, 'exactly one advanced input');
	ok(!textOf(advancedBox(open)).includes('放行置信度'), 'no allow-confidence field on this branch');
	ok(!textOf(advancedBox(open)).includes('改动概率上限'), 'and no change cap');
}

// ===========================================================================
// 4. Branch B (JEV 专用判官): three thresholds, then the connection group.
// ===========================================================================
{
	const tree = render({ draft: draftWith({ backend: 'jev' }), advanced: true });
	// The model row is gone: the model id lives in the connection now.
	ok(!textOf(tree).includes('判官模型'), 'the JEV branch has no 判官模型 row at the top');
	eq(rowByLabel(tree, '判官模型'), undefined, 'not a hidden one either: the row does not exist');
	eq(inputLabels(advancedBox(tree)), ['判官超时（毫秒）', '放行置信度', '改动概率上限'], 'the advanced fields, in card order');
	eq(advancedInputs(tree).length, 3, 'three of them, side by side');
	eq(all(advancedBox(tree), (node) => hasClass(node, 'Cp8sVz_cell')).length, 3, 'each in its own cell of the three-column grid');
	eq(all(advancedBox(tree), (node) => hasClass(node, 'Cp8sVz_cellHint')).length, 3, 'each with its one-line hint');
	// The grid is three columns, and it collapses on a narrow panel.
	const sheetText = readFileSync(resolve(here, 'lib', 'client.js'), 'utf8');
	ok(sheetText.includes('.Cp8sVz_grid{gap:10px;padding:10px 12px 12px;grid-template-columns:repeat(3,minmax(0,1fr));display:grid;box-sizing:border-box}'), 'the grid is three equal columns with one padding scale');
	ok(sheetText.includes('.Cp8sVz_grid{grid-template-columns:minmax(0,1fr)}'), 'and one column on a narrow panel');
}

// ===========================================================================
// 5. The JEV connection: 模型 ID / API 地址 / 密钥, under one 连接 caption.
// ===========================================================================
{
	const tree = render({ draft: draftWith({ backend: 'jev' }), advanced: true });
	const head = connectionHead(tree);
	ok(head !== undefined, 'the connection group opens with a caption row');
	eq(textOf(head), '连接', 'which reads 连接');
	const labels = inputLabels(tree);
	eq(labels.slice(-3), ['模型 ID', 'API 地址', '密钥'], 'then three rows: model id, endpoint, key');
	eq(labels.length, 6, 'six editable fields on this branch in total: three thresholds and the three connection rows');
	const connectionRows = rows(tree).filter((row) => ['模型 ID', 'API 地址', '密钥'].some((label) => textOf(row).startsWith(label)));
	eq(connectionRows.length, 3, 'each connection field is one row');
	// 模型 ID
	const modelInput = inputs(connectionRows[0])[0];
	eq(modelInput.props.placeholder, 'jev-latest', 'the model id hints jev-latest');
	eq(modelInput.props.value, JEV_VALUES.model, 'and renders the stored value, empty by default');
	eq(modelInput.props.type, 'text', 'a plain text box');
	// API 地址
	const urlInput = inputs(connectionRows[1])[0];
	eq(urlInput.props.placeholder, GATEWAY, 'the endpoint hints this machine gateway');
	eq(urlInput.props.value, GATEWAY, 'and shows the stored endpoint');
	ok(helpers.DEFAULT_BASE_URL === GATEWAY, 'which is the same literal the host defaults to');
	// 密钥
	const key = inputs(connectionRows[2])[0];
	eq(key.props.type, 'password', 'the key is masked by default');
	eq(key.props.value, '', 'and the box is empty even when a key is stored');
	eq(key.props.placeholder, '粘贴密钥', 'its placeholder invites a paste when nothing is stored');
	eq(key.props.autoComplete, 'off', 'no password manager decides to fill it');
	const reveal = buttons(connectionRows[2]).find((node) => textOf(node) === '显示');
	ok(reveal !== undefined, 'the reveal control sits inside the key row, to the right of the box');
	eq(reveal.props['aria-pressed'], false, 'and starts unpressed');
	const revealed = render({ draft: draftWith({ backend: 'jev' }), advanced: true, keyReveal: true });
	const shownKey = inputs(revealed).find((node) => node.props['aria-label'] === '密钥');
	eq(shownKey.props.type, 'text', 'pressed, the box shows what was typed');
	const hide = buttons(revealed).find((node) => textOf(node) === '隐藏');
	eq(hide?.props['aria-pressed'], true, 'and the control now reads 隐藏');
	// The connection group is JEV-only, so it never renders on the follow branch.
	eq(connectionHead(render({ draft: draftWith(FOLLOW), advanced: true })), undefined, 'the follow branch never renders a connection');
}

// ===========================================================================
// 6. The saved key: never echoed, one boolean, and an empty box never writes.
// ===========================================================================
{
	const saved = render({ draft: draftWith({ backend: 'jev', apiKey: '' }), view: viewWith({ apiKeyConfigured: true }) });
	const box = keyBox(saved);
	eq(box.props.value, '', 'a stored key is not put back in the box');
	eq(box.props.placeholder, '已保存，留空不改', 'the placeholder says it is saved and that empty keeps it');
	eq(box.props.type, 'password', 'still masked');
	const fresh = render({ draft: draftWith({ backend: 'jev' }), view: viewWith({ apiKeyConfigured: false }) });
	eq(keyBox(fresh).props.placeholder, '粘贴密钥', 'with nothing stored, the placeholder asks for a paste');
	// (a) an empty box, blurred, writes nothing — the "clear it and walk away"
	// path must not wipe the stored key.
	posts.length = 0;
	keyBox(saved).props.onBlur();
	await settle();
	eq(posts.length, 0, 'leaving the empty key box writes nothing at all');
	// (b) a typed key is written once, trimmed, and only that field.
	const typed = render({ draft: draftWith({ backend: 'jev', apiKey: '  sk-test-123  ' }), view: viewWith({ apiKeyConfigured: true }) });
	posts.length = 0;
	keyBox(typed).props.onBlur();
	await settle();
	eq(posts.length, 1, 'a typed key is written once on blur');
	eq(posts[0].url, '/api/dsh-cursor-modes/settings/mutate', 'through the settings bridge');
	eq(posts[0].body, { patch: { apiKey: 'sk-test-123' } }, 'as one trimmed apiKey patch, and nothing else');
	// (c) the two ordinary connection fields save the same way, and the address
	// is refused before the host sees it.
	const conn = render({ draft: draftWith({ backend: 'jev', model: 'my/custom-judge-1' }), view: viewWith() });
	posts.length = 0;
	const modelBox = inputs(conn).find((node) => node.props['aria-label'] === '模型 ID');
	modelBox.props.onBlur();
	await settle();
	eq(posts.length, 1, 'a changed model id is written once');
	eq(posts[0].body, { patch: { model: 'my/custom-judge-1' } }, 'as a model patch');
	const badUrl = render({ draft: draftWith({ backend: 'jev', baseUrl: 'openrouter.ai/api/v1' }), view: viewWith() });
	posts.length = 0;
	const urlBox = inputs(badUrl).find((node) => node.props['aria-label'] === 'API 地址');
	urlBox.props.onBlur();
	await settle();
	eq(posts.length, 0, 'an address with no protocol is refused on the spot, never sent');
	// (d) an unchanged field writes nothing either.
	const stable = render({ draft: draftWith({ backend: 'jev', baseUrl: GATEWAY }), view: viewWith() });
	posts.length = 0;
	inputs(stable).find((node) => node.props['aria-label'] === 'API 地址').props.onBlur();
	await settle();
	eq(posts.length, 0, 'blurring an endpoint that did not change writes nothing');
	// (e) a threshold is a number or it is not sent.
	const numbers = render({ draft: draftWith({ backend: 'jev', timeoutMs: '' }), view: viewWith(), advanced: true });
	posts.length = 0;
	advancedInputs(numbers)[0].props.onBlur();
	await settle();
	eq(posts.length, 0, 'an empty number box is not turned into zero');
	eq(dicts.zh['settings.numberInvalid'], '这里要填数字', 'the refusal is written, not silent');
}

// ===========================================================================
// 7. The deleted elements stay deleted.
// ===========================================================================
{
	const b = render({ draft: draftWith({ backend: 'jev' }), view: viewWith({ apiKeyConfigured: true }), advanced: true });
	const a = render({ draft: draftWith(FOLLOW), advanced: true });
	for (const tree of [a, b]) {
		const words = textOf(tree);
		ok(!words.includes('另选会单独计费'), 'no billing note');
		ok(!words.includes('最近判定'), 'no last-judgement row');
		ok(!words.includes('暂无'), 'and none of its empty-state text');
		ok(!words.includes('凭据引用'), 'no credential-reference row');
		ok(!words.includes('已配置'), 'no credential badge');
		ok(!words.includes('复用你正在用的模型'), 'no follow-route caption sentence');
		ok(!words.includes('用专用模型判定'), 'and no JEV-route caption sentence');
		ok(!words.includes('还没配置凭据'), 'no must-configure-credential line');
	}
	for (const key of ['settings.billingNote', 'settings.lastVerdict', 'settings.noVerdict', 'settings.allow', 'settings.deny', 'settings.credential', 'settings.configured', 'settings.unconfigured', 'settings.apiKeyRef', 'settings.credentialHintJev', 'settings.credentialHintLlm', 'settings.credentialMissing', 'settings.credentialMissingHint', 'settings.sourceFollowHint', 'settings.sourceJevHint', 'settings.modelCustom', 'settings.modelCustomLabel', 'settings.modelCustomHint', 'settings.modelCustomPlaceholder', 'settings.modelJevDefault', 'settings.modelSessionModel', 'settings.sourceField', 'settings.saved', 'settings.unsaved', 'settings.saving']) {
		ok(!(key in dicts.zh), 'the dictionary no longer carries ' + key);
		ok(!(key in dicts.en), 'nor its English copy: ' + key);
	}
	eq(all(b, (node) => hasClass(node, 'Cp8sVz_badge')).length, 0, 'no badge element survives');
	eq(all(b, (node) => hasClass(node, 'Cp8sVz_meta')).length, 0, 'no meta line survives');
	// The model name is not repeated in the source row: 判官模型 belongs to branch A.
	eq(textOf(rowByLabel(b, '判官来源')), '判官来源跟随当前模型JEV 专用判官', 'the source row names no model');
}

// ===========================================================================
// 8. 高级设置 starts collapsed, prints its numbers shut, and opens in place.
// ===========================================================================
{
	const collapsed = render({ draft: draftWith({ backend: 'jev' }), advanced: undefined });
	const disclosures = buttons(collapsed).filter((node) => node.props?.['aria-expanded'] !== undefined && textOf(node).includes('高级设置'));
	eq(disclosures.length, 1, 'there is one 高级设置 disclosure');
	eq(disclosures[0].props['aria-expanded'], false, 'and it starts collapsed');
	eq(advancedBox(collapsed), undefined, 'collapsed means no field stack is in the tree at all');
	const summary = textOf(disclosures[0]);
	ok(summary.includes('超时') && summary.includes(String(JEV_VALUES.timeoutMs)), 'the shut row prints the timeout it hides');
	ok(summary.includes('放行阈值') && summary.includes('改动上限'), 'and the two thresholds, on the JEV branch');
	ok(summary.includes('▸'), 'and points down-right, the design closed marker');
	const expanded = render({ draft: draftWith({ backend: 'jev' }), advanced: true });
	const openRow = buttons(expanded).filter((node) => node.props?.['aria-expanded'] !== undefined && textOf(node).includes('高级设置'))[0];
	eq(openRow.props['aria-expanded'], true, 'opened, the disclosure says so');
	ok(textOf(openRow).includes('▴'), 'and the marker flips');
	eq(openRow.props['aria-controls'], 'dsh-cursor-modes-settings-advanced', 'the disclosure names the body it opens');
	eq(advancedBox(expanded).props.id, 'dsh-cursor-modes-settings-advanced', 'and the body carries that id');
	// The follow branch's summary names only what it reads.
	const followShut = render({ draft: draftWith(FOLLOW), advanced: undefined });
	const followFoot = buttons(followShut).filter((node) => node.props?.['aria-expanded'] !== undefined && textOf(node).includes('高级设置'))[0];
	ok(textOf(followFoot).includes('超时'), 'the follow summary prints its timeout');
	ok(!textOf(followFoot).includes('放行阈值'), 'and none of the thresholds it does not read');
	eq(followFoot.props['aria-expanded'], false, 'still starting shut on that branch');
}

// ===========================================================================
// 9. Every input is one labelled control, and the busy state locks them.
// ===========================================================================
{
	const open = render({ draft: draftWith({ backend: 'jev' }), advanced: true });
	const boxes = inputs(open);
	eq(boxes.length, 6, 'six boxes: three thresholds and the three connection fields');
	eq(boxes.filter((node) => typeof node.props['aria-label'] !== 'string' || node.props['aria-label'] === '').length, 0, 'every box carries an aria-label');
	eq(boxes.filter((node) => node.props.onBlur === undefined).length, 0, 'and saves on blur');
	eq(all(open, (node) => node.type === 'label').length >= 3, true, 'the connection rows are real labels, so a click focuses the box');
	const busy = render({ draft: draftWith({ backend: 'jev' }), advanced: true, busy: true });
	eq(inputs(busy).filter((node) => node.props.disabled === true).length, 6, 'while a write is in flight every box is disabled');
	eq(all(busy, (node) => node.props?.role === 'switch')[0].props.disabled, true, 'and the switch too');
	const failed = render({ draft: draftWith({ backend: 'jev' }), error: 'gate apiKey must be a string' });
	const alert = all(failed, (node) => node.props?.role === 'alert')[0];
	ok(alert !== undefined, 'a refused write is shown, not swallowed');
	eq(textOf(alert), 'gate apiKey must be a string', 'with the host message verbatim');
	const loading = render({ view: null, draft: null });
	eq(textOf(all(loading, (node) => node.props?.role === 'alert')[0]), '读取中…', 'and the first paint says it is reading');
}

// ===========================================================================
// 10. The address rule, asserted directly: what may be stored.
// ===========================================================================
{
	eq(helpers.normalizeBaseUrl(' http://127.0.0.1:7899/api/v1/// '), GATEWAY, 'a stored address loses its whitespace and every trailing slash');
	eq(helpers.normalizeBaseUrl(''), '', 'an empty address stays empty: that is how the card says "use the default"');
	eq(helpers.normalizeBaseUrl(undefined), '', 'and a field the host never sent reads as empty');
	eq(helpers.baseUrlProblem(''), null, 'empty is storable');
	eq(helpers.baseUrlProblem('   '), null, 'so is whitespace only');
	eq(helpers.baseUrlProblem(GATEWAY), null, 'the local gateway is storable');
	eq(helpers.baseUrlProblem('https://example.test/v1'), null, 'an https address is storable');
	eq(helpers.baseUrlProblem('https://example.test/v1///'), null, 'a trailing slash is stripped, not refused');
	eq(helpers.baseUrlProblem('ftp://example.test/v1'), 'settings.baseUrlInvalid', 'ftp is refused');
	eq(helpers.baseUrlProblem('127.0.0.1:7899/api/v1'), 'settings.baseUrlInvalid', 'so is an address with no protocol');
	eq(helpers.baseUrlProblem('https://'), 'settings.baseUrlInvalid', 'and one with no host');
	eq(helpers.baseUrlProblem('http:/x'), 'settings.baseUrlInvalid', 'and a half-written scheme');
	eq(dicts.zh['settings.baseUrlInvalid'], '这里要填 http(s) 地址', 'the refusal is written in the card language');
	eq(helpers.DEFAULT_BASE_URL, GATEWAY, 'the placeholder names this machine gateway, not a public one');
	eq(helpers.GATE_FIELDS.map((field) => field.key), ['timeoutMs', 'allowConfidence', 'workReject'], 'the advanced stack edits exactly the three thresholds');
	eq(helpers.GATE_FIELDS.filter((field) => field.jevOnly === true).map((field) => field.key), ['allowConfidence', 'workReject'], 'two of them are JEV-only');
	eq(helpers.CONNECTION_FIELDS.map((field) => field.key), ['model', 'baseUrl', 'apiKey'], 'the connection edits exactly the model id, the endpoint and the key');
	eq(helpers.CONNECTION_FIELDS.map((field) => field.label), ['settings.modelId', 'settings.baseUrl', 'settings.apiKey'], 'in that order, with their own labels');
	ok(!('CUSTOM_MODEL' in helpers), 'the custom-model escape hatch is gone with the select');
}

// ===========================================================================
// 11. The copy: en and zh carry the same keys, and locale/*.json mirrors both.
// ===========================================================================
{
	const zhKeys = Object.keys(dicts.zh).sort();
	const enKeys = Object.keys(dicts.en).sort();
	eq(zhKeys, enKeys, 'both dictionaries carry the same keys, so no card falls back to a raw key');
	eq(enKeys.length, 54, 'the namespace has the fifty-four keys the four seats read');
	const zhFile = JSON.parse(readFileSync(resolve(here, 'locale', 'zh.json'), 'utf8'));
	const enFile = JSON.parse(readFileSync(resolve(here, 'locale', 'en.json'), 'utf8'));
	const entries = (object) => Object.keys(object).sort().map((key) => [key, object[key]]);
	eq(entries(zhFile), entries(dicts.zh), 'locale/zh.json mirrors the registered Chinese dictionary key for key');
	eq(entries(enFile), entries(dicts.en), 'locale/en.json mirrors the registered English dictionary key for key');
	const source = readFileSync(resolve(here, 'lib', 'client.js'), 'utf8');
	const asked = [...source.matchAll(/"(settings\.[A-Za-z0-9.]+)"/g)]
		.map((match) => match[1])
		.filter((key) => key !== 'settings.plugins.tab');
	const used = [...new Set(asked)].sort();
	ok(used.length >= 30, 'the scan really finds the settings.* keys the card asks for');
	eq(used.filter((key) => !(key in dicts.zh)), [], 'every settings.* key the card asks for exists in Chinese');
	eq(used.filter((key) => !(key in dicts.en)), [], 'and in English');
	eq(used.filter((key) => !(key in zhFile)), [], 'and in locale/zh.json');
	eq(used.filter((key) => !(key in enFile)), [], 'and in locale/en.json');
	for (const key of ['settings.connection', 'settings.modelId', 'settings.modelIdHint', 'settings.apiKey', 'settings.apiKeyHint', 'settings.apiKeyPlaceholder', 'settings.apiKeySaved', 'settings.show', 'settings.hide', 'settings.modelFollowHint', 'settings.timeout', 'settings.allowConfidence', 'settings.workReject', 'settings.advanced', 'settings.summaryTimeout', 'settings.summaryAllow', 'settings.summaryWorkReject', 'settings.baseUrl', 'settings.baseUrlHint', 'settings.timeoutHint']) {
		ok(typeof dicts.zh[key] === 'string' && dicts.zh[key] !== '', 'zh has ' + key);
		ok(typeof dicts.en[key] === 'string' && dicts.en[key] !== '', 'en has ' + key);
		ok(dicts.zh[key] !== dicts.en[key], key + ' is actually translated, not copied');
	}
	eq(te('settings.sourceFollow'), 'Use current model', 'the English source label is real English');
	eq(te('settings.sourceJev'), 'Dedicated JEV judge', 'the English JEV label matches the design wording');
	eq(dicts.zh[tab.options.label()], 'Cursor Plan 委派门禁', 'the settings tab is labelled Cursor Plan 委派门禁');
	eq(dicts.en[tab.options.label()], 'Cursor Plan delegation gate', 'and its English label says the same');
	eq(dicts.zh['settings.desc'].split(BT).length, 5, 'the description carries exactly two inline code spans');
	ok(dicts.en['settings.desc'].includes(BT + 'subagent' + BT) && dicts.en['settings.desc'].includes(BT + 'send_message' + BT),
		'both languages mark the same two tools');
	for (const key of ['settings.connection', 'settings.modelId', 'settings.modelIdHint', 'settings.apiKeyHint', 'settings.apiKeyPlaceholder', 'settings.apiKeySaved', 'settings.modelFollowHint', 'settings.baseUrlHint', 'settings.timeoutHint', 'settings.allowConfidenceHint', 'settings.workRejectHint']) {
		ok(dicts.zh[key].length <= 24, 'the Chinese copy stays one line: ' + key);
		ok(dicts.en[key].length <= 60, 'and so does the English one: ' + key);
	}
	eq(dicts.zh['settings.apiKeyPlaceholder'], '粘贴密钥', 'the empty key box asks for a paste');
	eq(dicts.zh['settings.apiKeySaved'], '已保存，留空不改', 'and a stored one says so');
	eq(dicts.zh['settings.show'], '显示', 'the reveal control is 显示');
	eq(dicts.zh['settings.hide'], '隐藏', 'and 隐藏 once pressed');
}

// ===========================================================================
// 12. The classes the card names are the classes the sheet defines, and the
// sheet paints with tokens only.
// ===========================================================================
{
	const source = readFileSync(resolve(here, 'lib', 'client.js'), 'utf8');
	const defined = new Set([...source.matchAll(/\.(Cp8sVz_[A-Za-z0-9]+)\{/g)].map((match) => match[1]));
	const named = [...source.matchAll(/([A-Za-z0-9]+): "(Cp8sVz_[A-Za-z0-9]+)"/g)].map((match) => [match[1], match[2]]);
	ok(named.length >= 20, 'the card names its classes through one map');
	eq(named.filter(([, className]) => !defined.has(className)).map(([key]) => key), [], 'every class the map names is defined in the injected sheet');
	const cardStart = source.indexOf('function CursorPlanSettingsCard({ t })');
	const cardSource = source.slice(cardStart, source.indexOf('//#endregion', cardStart));
	const mapKeys = new Set(named.map(([key]) => key));
	const used = [...new Set([...cardSource.matchAll(/(?<!["'])settings\.([A-Za-z0-9]+)/g)].map((match) => match[1]))];
	eq(used.filter((key) => !mapKeys.has(key)), [], 'every settings.<class> the card renders exists in that map');
	for (const key of ['card', 'row', 'rowTop', 'info', 'title', 'label', 'hint', 'switch', 'knob', 'seg', 'segBtn', 'segOn', 'segOff', 'selectRow', 'selectFixed', 'selectText', 'input', 'groupHead', 'grid', 'cell', 'cellLabel', 'cellHint', 'inputWide', 'reveal', 'foot', 'fields', 'field']) {
		ok(mapKeys.has(key), 'the design blocks all come from named classes: ' + key);
	}
	const sheetStart = source.indexOf('const settingsCss = [');
	const sheet = source.slice(sheetStart, source.indexOf('].join("")', sheetStart));
	eq(sheet.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], 'the sheet hard-codes no hex colour');
	eq(sheet.match(/\brgba?\(/g) ?? [], [], 'and no literal rgb() colour');
	ok(sheet.includes('var(--dsw-alias-'), 'every colour comes from a theme token');
	ok(sheet.includes('font-weight:600'), 'the title is the one 600');
	ok(sheet.includes('font:var(--dsw-font-xs-13)'), 'row labels come from the theme type scale');
	ok(sheet.includes('var(--dsw-radius-sm)'), 'the sheet corners come from the theme radius scale');
	const literalRadii = [...new Set([...sheet.matchAll(/border-radius:(?!var\()[^;}]+/g)].map((match) => match[0].slice('border-radius:'.length)))].sort();
	eq(literalRadii, ['10px', '50%', '6px'], 'the only hand-written radii are the pills, their knobs, and the 6px control step');
	ok(sheet.includes('.Cp8sVz_input{'), 'the inputs share one box style, so every control is the same height');
	ok(/\.Cp8sVz_input\{[^}]*height:28px/.test(sheet), 'which is 28px');
	ok(/\.Cp8sVz_reveal\{[^}]*height:28px/.test(sheet), 'and so is the reveal button beside the key');
	ok(/\.Cp8sVz_input\{[^}]*border-radius:6px/.test(sheet), 'with the same 6px corner as the reveal button');
	ok(/\.Cp8sVz_input\{[^}]*box-sizing:border-box/.test(sheet), 'and border-box, so the reach does not depend on the box');
	const rest = source.slice(0, sheetStart) + source.slice(source.indexOf('].join("")', sheetStart));
	ok(!/Cp8sVz_(chip|chevronOpen|cardOpen)/.test(rest), 'no chip/chevron/open-modifier leftovers');
}

console.warn = realWarn;

if (failures.length > 0) {
	console.error('FAILED: ' + failures.length + ' of ' + (passed + failures.length) + ' assertions');
	for (const failure of failures) console.error('  ✗ ' + failure);
	process.exit(1);
}
console.log('settings-ui: ' + passed + ' assertions passed');
