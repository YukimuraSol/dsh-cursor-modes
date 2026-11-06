#!/usr/bin/env node
// self-check-policy.mjs — the model-facing policy text of the merged
// dsh-cursor-modes plugin: the plan prompts (lib/prompts.js), the multitask
// section (lib/multi-prompt.js) and the two Build buttons (lib/build.js).
//
// Node straight up, no framework. It imports the real lib modules beside it, so
// an edit that changes what the model reads breaks here instead of in a session.
// Each family has teeth for one specific failure:
//
//  * prompts.js — the write exemption must appear exactly ONCE per prompt, and the
//    tool-free variant must be reachable by one substitution. A prompt that keeps
//    naming create_ui_block in a deployment without that tool teaches the model to
//    call a tool that does not exist; a prompt that loses the ~/.dsh/ui-blocks
//    allowlist makes plan mode refuse the one write it is supposed to allow.
//  * multi-prompt.js — MULTI_SECTION_TEAM is DERIVED from MULTI_SECTION by three
//    splices, so the base must stay clean of team wording while the variant is the
//    base plus exactly those tails. The reconstruction assertion at the end of that
//    section fails the moment either copy is hand-edited.
//  * build.js — "Build in Default" is byte-for-byte the pre-change message (its
//    sha256 is frozen here) and "Build in Multi" is that message plus one handoff
//    sentence. The two buttons carry different instructions, so drift between them
//    changes what the model does right after a click.
//
// Usage: node self-check-policy.mjs
// Prints "self-check-policy: N passed, M failed" and exits 1 on any failure.

import { createHash } from 'node:crypto';

import * as prompts from './lib/prompts.js';
import * as multiPrompt from './lib/multi-prompt.js';
import * as build from './lib/build.js';
// The budget receipt spells its window size out instead of importing this (the
// two pure modules would go circular), so the check is the only place that can
// prove the two numbers still agree.
import { LIMIT } from './lib/gate.js';
// The build route stages a default build's checklist in the one state bag; these
// checks drive the route directly, so they hand it a throwaway bag.
import { createState } from './lib/state.js';

let passed = 0;
const failures = [];
function ok(condition, label) {
	if (condition) passed++;
	else failures.push(label);
}
const short = (value) => {
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return text.length > 140 ? text.slice(0, 137) + '...' : text;
};
function eq(actual, expected, label) {
	if (Object.is(actual, expected)) passed++;
	else failures.push(label + ' (got ' + short(actual) + ', want ' + short(expected) + ')');
}

// A literal backtick, spelled out: the policy text is full of them, and a stray
// one inside a template literal is how an edit silently eats the rest of a prompt.
const BT = String.fromCharCode(96);
const tick = (token) => BT + token + BT;
const count = (text, needle) => text.split(needle).length - 1;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// ===========================================================================
// 1. exports — the surface the rest of the plugin imports by name
// ===========================================================================
const PROMPT_EXPORTS = [
	'UI_BLOCK_SENTENCE',
	'UI_BLOCK_SENTENCE_WITHOUT_TOOL',
	'MODE_RULES',
	'CREATE_PLAN_DESCRIPTION',
	'policyText',
	'renderChecklist'
];
for (const name of PROMPT_EXPORTS) ok(Object.hasOwn(prompts, name), 'prompts.js exports ' + name);
for (const name of PROMPT_EXPORTS.slice(0, 4)) eq(typeof prompts[name], 'string', name + ' is a string');
// Exactly these five, and no second plan prompt: a CONTINUE_PROMPT reappearing
// here is precisely the regression this change fixes (two sets = two cache
// misses per entry), so a sixth name has to be a deliberate, argued change.
eq(Object.keys(prompts).sort().join(','), PROMPT_EXPORTS.slice().sort().join(','), 'prompts.js exports exactly these six names');
ok(!Object.hasOwn(prompts, 'CONTINUE_PROMPT'), 'the continuation set is gone: plan mode renders one section for its whole life');
eq(typeof prompts.policyText, 'function', 'policyText is still a function');
eq(typeof prompts.renderChecklist, 'function', 'and renderChecklist is the other one: the single renderer for the one-shot checklist notice');
// A default export would be a second way to reach the same text, and nobody
// would keep the two in sync.
ok(!Object.hasOwn(prompts, 'default'), 'prompts.js carries no default export');

const MULTI_EXPORTS = ['BUDGET_RECEIPT', 'MULTI_ID', 'MULTI_SECTION', 'MULTI_SECTION_TEAM', 'budgetBrief', 'quotaToolDescription', 'withTeamTails'];
eq(
	Object.keys(multiPrompt).sort().join(','),
	MULTI_EXPORTS.slice().sort().join(','),
	'multi-prompt.js exports exactly the four constants plus the splice'
);
ok(!Object.hasOwn(multiPrompt, 'TEAM_TAILS'), 'TEAM_TAILS stays private: the splices are an implementation detail');
// BASE must be the derived one or the reconstruction below proves nothing.
eq(typeof multiPrompt.MULTI_SECTION_TEAM, 'string', 'MULTI_SECTION_TEAM is exported already derived');

// ===========================================================================
// 2. the write-exemption paragraph (the two variants and their one difference)
// ===========================================================================
// Spelled out rather than imported: a check that reads the constant it is
// checking cannot notice the constant changing.
const WITHOUT_TOOL =
	'Two kinds of writes are not execution and are allowed. Creation goes through the\n' +
	"artifact's own tool: " + tick('create_plan') + ' for the plan document. Revision goes in place with ' +
	tick('write') + ' or ' + tick('edit') + ': the plan\n' +
	'document itself, or an existing ' + tick('~/.dsh/ui-blocks/*.uiblock') + '. Both are planning material.\n' +
	'Everything else stays read-only.';
const UI_CLAUSE = ', ' + tick('create_ui_block') + ' for a UI\ndraft under ' + tick('~/.dsh/ui-blocks/') + '.';
const FULL_SENTENCE = WITHOUT_TOOL.replace('document. Revision', 'document' + UI_CLAUSE + ' Revision');

eq(prompts.UI_BLOCK_SENTENCE_WITHOUT_TOOL, WITHOUT_TOOL, 'the tool-free exemption is verbatim');
eq(prompts.UI_BLOCK_SENTENCE, FULL_SENTENCE, 'the full exemption is verbatim');
// The teeth: one substitution is all the section needs to swap variants, so the
// two strings may differ by that half-sentence and by nothing else.
eq(
	prompts.UI_BLOCK_SENTENCE.replace(UI_CLAUSE, '.'),
	prompts.UI_BLOCK_SENTENCE_WITHOUT_TOOL,
	'the two variants differ by exactly one half-sentence'
);
eq(
	count(prompts.UI_BLOCK_SENTENCE, UI_CLAUSE),
	1,
	'the removed half-sentence occurs once, so the swap cannot delete more than intended'
);
ok(
	prompts.UI_BLOCK_SENTENCE.includes(tick('create_ui_block')),
	'the full variant does name the tool, which is why the swap exists'
);
ok(!WITHOUT_TOOL.includes('create_ui_block'), 'the tool-free variant never mentions the absent tool');
ok(
	WITHOUT_TOOL.includes(tick('~/.dsh/ui-blocks/*.uiblock')),
	'the tool-free variant still allows REVISING an existing draft: that path is a rule, not a tool recommendation'
);
ok(WITHOUT_TOOL.includes('~/.dsh/ui-blocks/'), 'the tool-free variant still names the draft directory');
ok(WITHOUT_TOOL.includes(tick('create_plan')), 'the tool-free variant keeps the plan document half, which is always mounted');
ok(WITHOUT_TOOL.endsWith('.'), 'the tool-free variant ends with a period');
ok(
	WITHOUT_TOOL.endsWith('Everything else stays read-only.'),
	'the tool-free variant still re-asserts read-only for everything else'
);
ok(WITHOUT_TOOL.includes('Both are planning material.'), 'the tool-free variant keeps its closing clause');
eq(count(WITHOUT_TOOL, 'Two kinds of writes are not execution'), 1, 'the tool-free variant states the rule once');
// Deleting a clause in the middle of a sentence is how edits leave a seam
// ("...for the plan document Revision goes..."): assert the seam is gone.
ok(!WITHOUT_TOOL.includes('document Revision'), 'deleting the half-sentence did not weld two sentences together');
ok(!WITHOUT_TOOL.includes(', .'), 'no orphaned comma left behind');
ok(!WITHOUT_TOOL.includes(' .'), 'no double space before a period');
ok(!WITHOUT_TOOL.includes('\n\n'), 'the paragraph is still one block, not two');
ok(prompts.UI_BLOCK_SENTENCE.length > WITHOUT_TOOL.length, 'the tool-free variant is the shorter one');
// Stated as a boundary, never as an invitation: the passive wording is the point.
for (const cheer of ['you may', 'You may', 'feel free', 'Feel free', 'go ahead and', 'please']) {
	ok(!WITHOUT_TOOL.includes(cheer), 'the exemption carries no encouraging phrasing: ' + cheer);
	ok(!prompts.UI_BLOCK_SENTENCE.includes(cheer), 'the full exemption carries no encouraging phrasing: ' + cheer);
}

// ===========================================================================
// 3. MODE_RULES — the ONE constant, and the paragraph sits in it once
// ===========================================================================
const E = prompts.MODE_RULES;
const D = prompts.CREATE_PLAN_DESCRIPTION;

const ENTRY_FREE = E.replace(prompts.UI_BLOCK_SENTENCE, prompts.UI_BLOCK_SENTENCE_WITHOUT_TOOL);

eq(count(E, prompts.UI_BLOCK_SENTENCE), 1, 'the plan section carries the exemption exactly once');
// Exactly-once is what makes the swap safe: a second copy would survive it and
// the tool-free prompt would still name the missing tool.
ok(!ENTRY_FREE.includes('create_ui_block'), 'ONE substitution removes the tool name from the plan section');
eq(count(ENTRY_FREE, prompts.UI_BLOCK_SENTENCE_WITHOUT_TOOL), 1, 'the swapped section carries the tool-free variant once');
eq(
	ENTRY_FREE.length,
	E.length - (prompts.UI_BLOCK_SENTENCE.length - prompts.UI_BLOCK_SENTENCE_WITHOUT_TOOL.length),
	'the swap changed the plan section by that paragraph and nothing else'
);
ok(ENTRY_FREE.includes('you MUST NOT make any edits'), 'the swap leaves the blanket prohibition standing');
ok(ENTRY_FREE.includes('Everything else stays read-only.'), 'the swapped section still re-asserts read-only for everything else');

// --- entry set --------------------------------------------------------------
eq((E.match(/^\d+\. /gm) ?? []).length, 11, 'the entry set has its eleven numbered items');
for (let n = 1; n <= 11; n++) ok(E.includes('\n' + n + '. '), 'entry item ' + n + ' is present');
ok(E.includes('calling the create_plan tool'), 'entry names create_plan as how a plan is presented');
ok(E.includes('ask_user_question tool'), 'entry routes every question through ask_user_question');
ok(E.includes('via the subagent tool'), 'entry names this harness\'s subagent tool, not "the task tool"');
ok(E.includes('the card links to it'), 'entry states the card links the plan body instead of pasting it');
ok(E.includes('Do not paste the plan body into your reply'), 'entry forbids pasting the plan body');
ok(E.includes('<mermaid_syntax>'), 'entry keeps the mermaid syntax block');
ok(E.includes('exit_plan_mode'), 'entry tells the model not to reach for exit_plan_mode');
// 2026-10-24 (one plan section): the long delegation paragraph and the A1 rules
// set left with the continuation. Rule 5 scopes subagents to read-only research,
// and the only-way-out sentence moved INTO the entry set — with one section left
// it is the only place the model can read it.
ok(E.includes('explore with parallel read-only subagents'), 'entry scopes subagents to read-only research in rule 5');
ok(!E.includes('may be used only to serve the plan'), 'the retired delegation paragraph stays out: rule 5 and the blanket prohibition cover subagents');
// 2026-10-29: the blanket "supersedes any other instructions" was narrowed on
// purpose -- three sections now coexist, so it may not cancel the marker rules.
ok(E.includes('This overrides any other instruction that would have you change the system'), 'the write ban overrides other instructions');
ok(E.includes('it does not override the mode-marker rules above'), 'and it is narrowed: it cannot cancel the marker rules');
ok(E.includes('Only the user can change the mode'), 'the only-way-out sentence lives in the one section the model reads');
ok(E.includes('Later feedback revises the plan'), 'and says what later feedback is: a revision, not a go-ahead');
ok(E.includes('fold it into the plan document rather than executing'), 'feedback is folded into the document instead of executed');
ok(E.includes('you MUST NOT make any edits'), 'entry keeps the blanket prohibition');

// --- the retired continuation must not come back as a second section --------
// Each line below used to be asserted against CONTINUE_PROMPT. That constant is
// gone, so the same absences are asserted against the one remaining section: the
// continuation reappearing shows up as one of these strings. Its four duplicated
// checks (question routing, delegation rule, only-way-out, blanket prohibition)
// are asserted in the entry-set block above, where those rules now live.
eq((E.match(/^- "/gm) ?? []).length, 0, 'the section carries no example list: the execution examples were the continuation\'s');
ok(!E.includes('Plan mode is still active'), 'no continuation opening: the section reads the same on every turn');
ok(!E.includes('To speed up initial research'), 'the retired entry-list variant stays gone');
ok(!E.includes('go ahead and do so'), 'the retired A3 go-ahead line stays gone');
ok(!E.includes('The ONLY time execution happens'), 'the conflicting execution sentence stays gone');

// --- ordering: the exemption is appended, never substituted ------------------
const RULES_ANCHOR = '11. Every question to the user';
const DELEGATION_RULE =
	'Never use them, or any other tool, to execute or implement the plan — even if the user asks you to.';
// One reminder block per section: the section is spliced in as a unit, and a
// half-open tag would swallow whatever follows in the system prompt.
eq(count(E, '<mode_rules>'), 1, 'the constant has one opening mode-rules tag');
eq(count(E, '</mode_rules>'), 1, 'the constant has one closing mode-rules tag');
ok(E.trimEnd().endsWith('</mode_rules>'), 'the constant closes mode_rules at the very end');
ok(!E.includes('<system_reminder>'), 'the plan-only reminder wrapper is gone: all three modes read this one block');
// The exemption is appended AFTER the rules, never spliced into them: appending
// is what lets the rules keep their wording.
ok(E.indexOf(RULES_ANCHOR) < E.indexOf(prompts.UI_BLOCK_SENTENCE), 'the plan section appends the exemption after its rules');
// The delegation paragraph is retired (rule 5 plus the blanket prohibition carry
// it now); with only one section left, nothing may reintroduce it verbatim.
ok(!E.includes(DELEGATION_RULE), 'the retired delegation rule stays out of the section');
ok(!E.includes('Rules:'), 'and so does the continuation rule list it lived in');

// --- variants that must stay out (the section and the tool description) -----
// One section now, so each banned variant is checked against two texts instead
// of three. The two continuation markers are listed too: the retired set is the
// variant most likely to creep back, so its absence is asserted systematically.
const BANNED = [
	'<begin_plan_mode/>',
	'Current plan mode progress',
	'<concrete_plans>',
	'<build_with_multitask_instructions>',
	'SwitchMode',
	'AskQuestion',
	'mcp_create_plan',
	'CreatePlan',
	'# Examples',
	'When NOT to execute the plan'
];
for (const banned of BANNED) {
	for (const [label, text] of [['ENTRY_PROMPT', E], ['CREATE_PLAN_DESCRIPTION', D]]) {
		ok(!text.includes(banned), label + ' must not contain ' + banned);
	}
}

// --- the plan's two headings, named once for this whole section -------------
const OVERVIEW_HEADING = '## 方案设计';
const DETAIL_HEADING = '## 技术细节';
const CHECKLIST_HEADING = '## 执行清单';

// --- the tool description: short, and it points at the ONE shape spec -------
// 2026-10-24 (planv3): the description used to BE the spec. It now defers to the
// plan-mode instructions in ENTRY_PROMPT, so these lines check the pointer plus
// few rules the tool still owns; the body rules themselves are asserted against
// the entry set below. A description that quietly grew a second copy of them is
// the drift this split exists to prevent, so the moved rules are asserted ABSENT
// here, not merely unasserted.
ok(D.includes('Use this tool to create a concise plan'), 'description opens by saying what the tool is for');
ok(D.includes('at the end of the planning phase'), 'description says when to call it');
ok(D.includes('once the shape of the change is settled'), 'description pins the end of planning to a settled shape');
ok(D.includes('finalize and store the plan'), 'description says the call stores the plan');
ok(D.includes('The first line MUST BE A TITLE'), 'description pins the title rule');
ok(D.includes('a plan without one is rejected'), 'description says the title is enforced, not advised');
ok(
	D.includes("The document's shape is fixed by the plan-mode instructions"),
	'description hands the shape to the plan-mode instructions instead of restating it'
);
ok(D.includes(tick('todos')), 'description names the todos argument');
ok(D.includes('the card renders it below the body'), 'description says the CARD renders the checklist, not the model');
ok(D.includes('执行清单'), 'description names the heading the card prints');
ok(D.includes('one sentence per item'), 'description caps a checklist item at one sentence');
ok(D.includes('unique id'), 'description requires a unique checklist id');
ok(D.includes('always "pending"'), 'description pins a todo status to pending while the plan is written');
ok(D.includes('a plan that has not run'), 'description says why that status is pending');
ok(!D.includes('create_ui_block'), 'the description never names the ui-block tool');
ok(!D.includes(prompts.UI_BLOCK_SENTENCE), 'the description never carries the write exemption');
ok(!D.includes('implementation details'), 'the description no longer closes on an implementation-detail focus line');
ok(!D.includes('UPDATING THE PLAN:'), 'the update rules left the description for the plan-mode entry set');
ok(!D.includes('read and edit'), 'the read-and-edit revision rule moved with them');
ok(!D.includes('ask_user_question'), 'so did the question rule: the entry set owns it');
ok(
	!D.includes(OVERVIEW_HEADING) && !D.includes(DETAIL_HEADING),
	'and the two section headings are not restated here'
);
ok(!D.includes(CHECKLIST_HEADING), 'nor is the checklist heading');

// --- the plan's shape: ONE sketch, inside the entry set ----------------------
// 2026-10-24 (planv4): the fixed <plan_document> spec is gone. The model did not
// follow a mandatory section list, so the prompt now sketches a shape in one
// prose paragraph ("an extra section is fine") and fixes the voice separately.
// These lines assert the sketch's anchors, and that the retired hard rules did
// not creep back in: absence is asserted, not merely left unasserted.
const SHAPE_OPEN = 'Plan shape, roughly:';
const SHAPE_CLOSE = 'calling the tool again creates a second file.';
eq(count(E, SHAPE_OPEN), 1, 'the plan shape is sketched once');
eq(count(E, SHAPE_CLOSE), 1, 'and closed once');
const SHAPE_AT = E.indexOf(SHAPE_OPEN);
const DOC = E.slice(SHAPE_AT, E.indexOf(SHAPE_CLOSE) + SHAPE_CLOSE.length);
ok(DOC.length > 200, 'the sketch is the real spec, not a stub');
ok(SHAPE_AT > E.indexOf('11. Keep the plan proportional'), 'the sketch follows the numbered rules');
ok(SHAPE_AT < E.indexOf(prompts.UI_BLOCK_SENTENCE), 'and precedes the write exemption');
// The two headings are still named, verbatim, once each.
eq(count(E, OVERVIEW_HEADING), 1, 'the sketch names the design heading exactly once, verbatim');
eq(count(E, DETAIL_HEADING), 1, 'the sketch names the detail heading exactly once, verbatim');
// What replaced the two-section ceiling: a rough shape, plus permission to add
// one more section when the change needs it. A fixed form is what got ignored.
ok(DOC.includes('That is usually all a plan needs'), 'the sketch names the usual minimum');
ok(DOC.includes('an extra section is fine'), 'one extra section is allowed when the change needs it');
ok(DOC.includes('keep that extra section short'), 'while capping that extra section, and only it');
ok(!DOC.includes('exactly two sections'), 'the two-section ceiling is gone');
ok(!DOC.includes('no other ' + tick('##')), 'the no-other-heading ban is gone');
ok(!DOC.includes('no sub-headings'), 'the no-sub-heading ban is gone');
ok(!DOC.includes('never translated'), 'the headings are literal Chinese, so no translation rule is spelled out');
// 2026-11-01 (plan-shape-overview-first): the section is 方案设计 now and its job
// flipped from "one-line overview" to "the plan itself". The old phrase is what made
// it read as a summary, so its absence is asserted, not just left unasserted. The
// third check is the tooth: a section that drifts back to "keep it short" goes red.
ok(
	DOC.includes('the plan itself, not a summary of it'),
	'the design section is the plan itself, never a summary of it'
);
ok(
	DOC.includes('what the user will notice') && !DOC.includes('what will be different and what the user will notice'),
	'the design section says what changes and what the user notices, not the retired one-line overview phrase'
);
ok(
	DOC.includes('as specific as the change requires') && DOC.includes('there is no word limit on this section') && !DOC.includes('keep it short'),
	'the design section carries no word limit and stays as specific as the change requires: "keep it short" must not come back'
);
ok(
	DOC.includes('do not turn colloquial') && DOC.includes('the voice rule below still holds'),
	'the design section keeps the one voice rule: plain, not colloquial'
);
// The detail section: one anchor per line, each with its own check.
ok(DOC.includes('the anchors, one line each'), 'the detail section is one anchor per line');
ok(!DOC.includes('at most eight'), 'the eight-line cap is gone');
ok(DOC.includes(tick('file:line')), 'an anchor starts with file:line');
ok(DOC.includes('what it is now → what it becomes'), 'an anchor names the change it makes');
ok(DOC.includes('how to verify'), 'an anchor says how it is verified');
ok(!DOC.includes('never paste code'), 'the detail-section code-paste ban is gone');
// The checklist is DATA, and the card prints its heading.
ok(
	DOC.includes('The checklist is the ' + tick('todos') + ' argument'),
	'the checklist is the todos argument, never body text'
);
ok(DOC.includes('the card renders as 执行清单'), 'the card prints the checklist heading, the body never does');
ok(DOC.includes('one sentence per item'), 'each checklist item is one sentence');
ok(DOC.includes('unique id'), 'each checklist item carries a unique id');
ok(DOC.includes('status ' + tick('pending')), 'the snapshot status is pending while the plan is a plan');
ok(!E.includes(CHECKLIST_HEADING), 'the prompt never asks for an execution checklist inside the body');
// Revision stays a file edit, not a second plan.
ok(DOC.includes('To change the plan later, read and edit the file itself'), 'the sketch sends a revision to the file in place');
ok(DOC.includes('calling the tool again creates a second file'), 'the sketch says a second call makes a second file');
ok(!E.includes(tick('[backend/src/foo.ts](backend/src/foo.ts)')), 'the markdown-link example left with the fixed spec');
// The three optional trailing markers (不做/复用/前提) were part of the fixed
// form and left with it; the sketch carries no replacement for them.
for (const marker of ['不做：', '复用：', '前提：']) {
	ok(!DOC.includes(marker), 'the optional decision marker left with the fixed spec: ' + marker);
}
ok(!E.includes('No emojis'), 'the no-emoji rule left with the fixed spec');
ok(!E.includes('A small mermaid diagram beats a paragraph'), 'the diagram nudge left with the fixed spec');

// --- the voice constraint (2026-10-24, planv4) ------------------------------
// Concise is not colloquial: the one register rule the prompt carries, and the
// replacement for the retired shape bans. Each phrase below is load-bearing.
ok(E.includes('Language: plain and declarative'), 'the prompt pins the register: plain and declarative');
ok(E.includes('Concise is not colloquial'), 'and says brevity does not license a spoken voice');
ok(E.includes('state what is true and what will change'), 'the register is defined by what it states');
for (const aside of ['no spoken asides', 'no rhetorical questions', 'no second-person chat', 'no hype']) {
	ok(E.includes(aside), 'the voice rule names it: ' + aside);
}
for (const marker of ['说白了', '其实', '你看']) {
	ok(E.includes(marker), 'the colloquial tell is named: ' + marker);
}

// --- the eleven rules still each say their one thing ------------------------
ok(E.includes('Write 不确定 rather than inventing a fact'), 'item 4 marks an unknown instead of inventing a fact');
ok(E.includes('Never ask whether to start work'), 'item 3 forbids a start-work question');
ok(E.includes('never ask where code lives'), 'item 3 says the codebase is looked up, not asked about');
ok(
	E.includes('several implementations would each change the plan significantly'),
	'item 2 asks which implementation when the choice changes the plan'
);
ok(E.includes('A conversational yes approves nothing'), 'item 8: a yes in chat approves nothing');
ok(
	E.includes('Fold the confirmed decision into the plan and submit again'),
	'item 8 folds the confirmation into the plan instead of starting work'
);
ok(E.includes('Do not use todo_write during planning'), 'item 9 keeps the checklist out of the planning pass');
ok(E.includes('Keep the plan proportional to the request'), 'item 11 keeps the plan proportional');
ok(E.includes('this deployment does not install it'), 'item 7 says exit_plan_mode is absent in this deployment');

// ===========================================================================
// 4. policyText — ONE answer, whatever the mode and whatever the header
// ===========================================================================
// 2026-10-29 (stable prefix): the answer stopped depending on the mode at all.
// A mode-dependent section is exactly what made a switch invalidate the cached
// prefix, so "ignores both arguments" is the invariant these lines pin.
eq(prompts.policyText('plan', null), E, 'plan mode with no header yet -> the constant');
eq(prompts.policyText('plan', 'default'), E, 'header said default -> the same constant');
eq(prompts.policyText('plan', 'plan'), E, 'header already said plan -> the SAME constant: there is no second set');
eq(prompts.policyText('plan', 'multi'), E, 'any other header value -> the same constant too');
eq(prompts.policyText('plan', undefined), E, 'an absent header -> the same constant');
eq(
	prompts.policyText('plan', 'plan'),
	prompts.policyText('plan', null),
	'the section is byte-identical on the entry turn and every turn after it'
);
eq(prompts.policyText.length, 2, 'the 2-arg signature is kept: callers still pass the header, it just selects nothing');
eq(prompts.policyText(null, null), E, 'an absent mode -> the whole constant, so default is never textless');
eq(prompts.policyText('multi', 'multi'), E, 'multitask mode -> the same constant');
eq(prompts.policyText('multi', null), E, 'multitask mode without a header -> the same constant');
eq(prompts.policyText('default', 'default'), E, 'the default mode -> the same constant');
eq(prompts.policyText('', ''), E, 'the empty mode -> the same constant');
eq(prompts.policyText('PLAN', 'plan'), E, 'a case variant -> the same constant: nothing selects on the string');
eq(prompts.policyText('plan ', 'plan'), E, 'and neither does whitespace');
// One answer across the whole cross product: never a fragment, never a variant
// chosen by the caller. The section applies the create_ui_block substitution
// itself, after this call, so policyText stays the pure constant.
const answers = new Set();
for (const mode of ['plan', 'multi', 'default', null, '', 'cursor-plan', 'PLAN', 'plan ']) {
	for (const header of [mode, null, undefined, 'plan', 'default']) answers.add(prompts.policyText(mode, header));
}
eq(answers.size, 1, 'every mode/header pair answers exactly the same text');
eq([...answers][0], E, 'and that text is the constant itself, not a copy');
eq(prompts.policyText('plan', 'plan').length, E.length, 'the answer is the constant itself, not a copy');
eq(prompts.policyText('plan', null).length, E.length, 'and the same answer measures the same');

// ===========================================================================
// 5. MULTI_ID / the multitask section and its derived team variant
// ===========================================================================
const OPENING = 'The user has engaged **Multitask Mode**.';
eq(multiPrompt.MULTI_ID, 'multi', 'MULTI_ID is the persisted mode id; renaming it orphans every session');
eq(build.BUILD_TARGETS.multi, multiPrompt.MULTI_ID, 'the Build button and the mode id agree on "multi"');

const BASE = multiPrompt.MULTI_SECTION;
const TEAM = multiPrompt.MULTI_SECTION_TEAM;
ok(BASE.startsWith(OPENING), 'MULTI_SECTION opens with the mode declaration');
ok(TEAM.startsWith(OPENING), 'the team variant opens with the same declaration: splicing must not disturb it');
eq(count(TEAM, OPENING), 1, 'the team variant announces the mode once, not twice');
ok(BASE.length > 0, 'MULTI_SECTION is not empty');
ok(TEAM.length > BASE.length, 'the team variant ADDS text; a shorter one means a tail overwrote something');
ok(TEAM.length - BASE.length > 400, 'the three tails are all there, not just one');
ok(BASE.includes(tick('subagent') + ' tool'), 'the section names this harness\'s subagent tool');
ok(BASE.includes('NEVER await or sleep'), 'the section forbids waiting on a running worker');
ok(BASE.includes('more than just one tool call'), 'the delegation threshold is still stated');
ok(BASE.includes('NO or ONE tool calls'), 'trivial requests stay in the foreground');
ok(BASE.includes('unless they ask'), 'the instructions may be quoted when the user asks');
ok(!BASE.includes('EXITED your previous mode'), 'the section must not announce an exit it cannot verify');
ok(!BASE.includes('even if asked'), 'asking may quote the instructions');
ok(!BASE.includes('requires ANY tool calls'), 'the composer2 delegate line is a different variant');
ok(!BASE.includes('YOU MUST DELEGATE TO AN ASYNCHRONOUS SUBAGENT'), 'the composer2 absolute rule is absent');
ok(!BASE.includes('end your response IMMEDIATELY'), 'the composer2 end-immediately rule is absent');
ok(!BASE.includes('[section:'), 'extractor section tags never reach the prompt');
ok(!BASE.includes('Ignore any "persistence" instructions'), 'the persistence sentence is not rendered');
ok(!BASE.includes('check it before you rely'), 'the section does not invite re-checking delegated work');
ok(/\S$/.test(BASE), 'the section does not end mid-sentence');

// --- the three anchors the tails splice onto --------------------------------
// The first anchor contains a backtick, built here so this file carries none.
const ANCHOR_SET_TO = 'set to ' + tick('true') + '.';
const ANCHOR_NOTIFY = 'you will be notified when the subagent completes.';
const ANCHOR_CEILING = 'not about maximizing the number of parallel agents.';
eq(count(BASE, ANCHOR_SET_TO), 1, 'the "set to true" anchor appears exactly once');
eq(count(BASE, ANCHOR_NOTIFY), 1, 'the "notified when the subagent completes" anchor appears exactly once');
eq(count(BASE, ANCHOR_CEILING), 1, 'the "not about maximizing" anchor appears exactly once');
// .replace(anchor, ...) only touches the FIRST hit, so a duplicated anchor would
// silently leave the extra copy without its tail.
for (const anchor of [ANCHOR_SET_TO, ANCHOR_NOTIFY, ANCHOR_CEILING]) {
	eq(count(TEAM, anchor), 1, 'the team variant still carries this anchor once: ' + short(anchor));
}
const at = (text, anchor) => text.indexOf(anchor);
ok(at(BASE, ANCHOR_SET_TO) < at(BASE, ANCHOR_NOTIFY), 'the anchors keep their order: delegate, then notify');
ok(at(BASE, ANCHOR_NOTIFY) < at(BASE, ANCHOR_CEILING), 'the anchors keep their order: notify, then ceiling');
ok(at(TEAM, ANCHOR_SET_TO) < at(TEAM, ANCHOR_NOTIFY), 'the team variant keeps the delegate/notify order');
ok(at(TEAM, ANCHOR_NOTIFY) < at(TEAM, ANCHOR_CEILING), 'the team variant keeps the notify/ceiling order');

// --- the base constant must stay clean of team wording ----------------------
for (const keyword of ['team_task_create', 'spawn_teammate', 'not a waiting room', 'not over-decomposition', 'wait_agent', 'teammate']) {
	ok(!BASE.includes(keyword), 'the base section stays free of team wording: ' + keyword);
}

// --- the variant carries each team tail exactly once ------------------------
for (const keyword of ['team_task_create', 'spawn_teammate', 'not a waiting room', 'not over-decomposition']) {
	eq(count(TEAM, keyword), 1, 'the team variant names it exactly once: ' + keyword);
}
ok(TEAM.includes(tick('wait_agent')), 'the team variant names the tool it forbids parking in');
// Reconstruction: strip the three inserted tails and the base must come back
// byte for byte. This is what proves the variant is DERIVED, not a second copy
// someone will forget to update.
const SEG_1 = BASE.slice(at(BASE, ANCHOR_SET_TO) + ANCHOR_SET_TO.length, at(BASE, ANCHOR_NOTIFY));
const SEG_2 = BASE.slice(at(BASE, ANCHOR_NOTIFY) + ANCHOR_NOTIFY.length, at(BASE, ANCHOR_CEILING));
const TAIL_1 = TEAM.slice(at(TEAM, ANCHOR_SET_TO) + ANCHOR_SET_TO.length, TEAM.indexOf(SEG_1));
const TAIL_2 = TEAM.slice(at(TEAM, ANCHOR_NOTIFY) + ANCHOR_NOTIFY.length, TEAM.indexOf(SEG_2));
// Everything after the last anchor in the base is what must survive untouched
// after the third tail, so the tail is measured up to that point.
const BASE_REST = BASE.slice(at(BASE, ANCHOR_CEILING) + ANCHOR_CEILING.length);
const TAIL_3 = TEAM.slice(at(TEAM, ANCHOR_CEILING) + ANCHOR_CEILING.length, TEAM.indexOf(BASE_REST));
ok(BASE_REST.length > 1000, 'the base really has text after the last anchor, so tail 3 is not the whole ending');
ok(TEAM.includes(SEG_1), 'the base text between the first two anchors survives unedited in the variant');
ok(TEAM.includes(SEG_2), 'the base text between the last two anchors survives unedited in the variant');
ok(TAIL_1.includes('team_task_create') && TAIL_1.includes('spawn_teammate'), 'tail 1 arrives right after the "set to true" anchor');
ok(TAIL_2.includes('not a waiting room'), 'tail 2 arrives right after the notify anchor');
ok(TEAM.endsWith(BASE_REST), 'the base resumes byte for byte after tail 3: the splice did not truncate the guidelines');
ok(TAIL_3.includes('not over-decomposition'), 'tail 3 is the ceiling carve-out');
ok(TAIL_3.startsWith(' '), 'each tail begins with a space, so it renders as one more sentence');
ok(TAIL_1.startsWith(' '), 'tail 1 begins with a space too');
ok(TAIL_2.startsWith(' '), 'tail 2 begins with a space too');
ok(TAIL_3.length < 200, 'tail 3 stays one sentence, not a paragraph');
eq(
	TEAM.split(TAIL_1).join('').split(TAIL_2).join('').split(TAIL_3).join(''),
	BASE,
	'stripping the three tails reconstructs MULTI_SECTION byte for byte'
);
// The reconstruction only proves the tails were SPLICED; it says nothing about
// what they say. Pin each one verbatim, or a reworded tail still reconstructs
// and the model silently gets new instructions.
const TEAM_TAIL_1 = ' When the user explicitly asks for Agent Teams, that same coordinator role also covers'
	+ ' named teammates and the shared task board: plan the work on ' + tick('team_task_create')
	+ ', start the teammates with ' + tick('spawn_teammate') + ', then hand the foreground back.';
const TEAM_TAIL_2 = ' This holds for teammates too: once the work is dispatched, end your response'
	+ ' — do not sit in ' + tick('wait_agent') + ' while they run. ' + tick('wait_agent')
	+ ' is for one status recheck, not a waiting room; end the turn after it.'
	+ ' Ending the turn is not the same as giving the final answer: you are woken when teammates'
	+ ' report, and only then do you synthesize.';
const TEAM_TAIL_3 = ' The same ceiling applies to sibling subagent calls;'
	+ ' teammates the user explicitly asked for are not over-decomposition.';
eq(TAIL_1, TEAM_TAIL_1, 'team tail 1 is verbatim: it names both team tools and hands the foreground back');
eq(TAIL_2, TEAM_TAIL_2, 'team tail 2 is verbatim: wait_agent is one recheck, never a waiting room');
eq(TAIL_3, TEAM_TAIL_3, 'team tail 3 is verbatim: asked-for teammates are not over-decomposition');
eq(
	TEAM_TAIL_1.length + TEAM_TAIL_2.length + TEAM_TAIL_3.length,
	TEAM.length - BASE.length,
	'the variant is the base plus exactly these three tails and nothing else'
);
ok(TEAM.startsWith(BASE.slice(0, at(BASE, ANCHOR_SET_TO) + ANCHOR_SET_TO.length)), 'the variant shares the base prefix up to tail 1');
ok(TEAM.indexOf(TAIL_3) > TEAM.indexOf(TAIL_1), 'the tails appear in the order they are spliced');

// --- the merged constant grows the same variant ------------------------------
// MODE_RULES carries the multitask rules too, so a deployment that mounts
// spawn_teammate needs the same three sentences inside it. The splice must run
// through multi-prompt's own reducer — a re-typed anchor in a second place is how
// the two definitions drift, and a missing splice is how a team deployment loses
// the rules without anyone noticing.
const RULES = prompts.MODE_RULES;
eq(typeof multiPrompt.withTeamTails, 'function', 'multi-prompt exports its splice, so callers reuse it instead of copying the anchors');
eq(multiPrompt.withTeamTails(BASE), TEAM, 'the exported splice is exactly the one that produces MULTI_SECTION_TEAM');
const RULES_TEAM = multiPrompt.withTeamTails(RULES);
ok(RULES_TEAM !== RULES, 'applying it to the merged constant actually changes the text');
for (const anchor of [ANCHOR_SET_TO, ANCHOR_NOTIFY, ANCHOR_CEILING]) {
	eq(count(RULES, anchor), 1, 'the merged constant carries the anchor exactly once: ' + anchor);
	eq(count(RULES_TEAM, anchor), 1, 'and the splice does not duplicate it: ' + anchor);
}
for (const tail of [TEAM_TAIL_1, TEAM_TAIL_2, TEAM_TAIL_3]) {
	eq(count(RULES, tail), 0, 'the plain constant never carries a team tail');
	eq(count(RULES_TEAM, tail), 1, 'the merged team variant carries each tail exactly once');
}
ok(RULES_TEAM.indexOf(TEAM_TAIL_1) > RULES_TEAM.indexOf(ANCHOR_SET_TO), 'the first merged tail lands after its own anchor');
ok(RULES_TEAM.indexOf(TEAM_TAIL_2) > RULES_TEAM.indexOf(TEAM_TAIL_1), 'then the second');
ok(RULES_TEAM.indexOf(TEAM_TAIL_3) > RULES_TEAM.indexOf(TEAM_TAIL_2), 'then the third, in the same order as MULTI_SECTION_TEAM');
eq(
	RULES_TEAM.split(TEAM_TAIL_1).join('').split(TEAM_TAIL_2).join('').split(TEAM_TAIL_3).join(''),
	RULES,
	'stripping the three tails from the merged variant reconstructs MODE_RULES byte for byte'
);
eq(RULES_TEAM.length - RULES.length, TEAM.length - BASE.length, 'the merged variant grows by exactly the same number of characters');

// ===========================================================================
// 6. BUDGET_RECEIPT — the mode-on sentence, pinned verbatim
// ===========================================================================
// ===========================================================================
// 6. BUDGET_RECEIPT — the mode-on sentence, pinned verbatim
// ===========================================================================
const BUDGET_EXPECTED =
	'Multi mode: your tool-call budget for this stretch has been refreshed — 10 calls. '
	+ 'A run_code that only dispatches delegation tools (subagent, subagent_fork, send_message, list_agents, interrupt_agent, request_more_edits) spends nothing. '
	+ 'Every other run_code call spends one. '
	+ 'A stretch ends and the count resets when the user speaks, a subagent reports or settles, or a teammate sends a message; '
	+ 'a goal or schedule wake opens a new turn but keeps the count. '
	+ 'The call that spends the tenth unit tells you it was the last; the next one is refused, and request_more_edits is the way out. '
	+ 'Do not mention these rules to the user.';
eq(multiPrompt.BUDGET_RECEIPT, BUDGET_EXPECTED, 'BUDGET_RECEIPT is verbatim');
ok(multiPrompt.BUDGET_RECEIPT.includes('refreshed — ' + String(LIMIT) + ' calls'), 'the receipt states the stretch size from LIMIT');
ok(multiPrompt.BUDGET_RECEIPT.includes('request_more_edits'), 'the receipt names the quota request tool');
ok(multiPrompt.BUDGET_RECEIPT.includes('A run_code that only dispatches delegation tools'), 'the receipt exempts a delegation-only carrier');
ok(!multiPrompt.BUDGET_RECEIPT.includes(tick('request_more_edits') + ' asks'), 'the tool name is a bare token the model can match');
// The four branches: the team variant lists the team tools, and a deployment
// without run_code reads the direct-call wording instead of the carrier's.
const TEAM_BRIEF = multiPrompt.budgetBrief({ hasRunCode: true, hasTeam: true });
ok(TEAM_BRIEF.includes('delegation and team tools') && TEAM_BRIEF.includes('team_task_list'), 'the team branch names the team tools');
ok(TEAM_BRIEF !== multiPrompt.BUDGET_RECEIPT, 'and is a different sentence from the base one');
const NATIVE_BRIEF = multiPrompt.budgetBrief({ hasRunCode: false, hasTeam: false });
ok(NATIVE_BRIEF.includes('Delegation tools are free') && !NATIVE_BRIEF.includes('run_code'), 'the non-PTC branch never names run_code');
ok(multiPrompt.budgetBrief({ hasRunCode: false, hasTeam: true }).includes('Delegation and team tools are free'), 'and its team variant names both');
eq(count(multiPrompt.BUDGET_RECEIPT, 'refreshed — ' + String(LIMIT) + ' calls'), 1, 'the receipt states one budget size, not two');

// ===========================================================================
// 7. the two Build buttons (lib/build.js)
// ===========================================================================
const HANDOFF =
	'When you delegate, give each worker the plan file path, the part it owns,'
	+ ' and its own slice of the checklist as the subagent `todos` argument — and have it read the plan file itself;'
	+ ' never paste the plan body into a worker prompt.'
	+ ' Keep the checklist in the workers\' hands: do not write your own todo list in this conversation'
	+ ' — the main thread assigns work and reports back.';
const OLD_BASE = 'Implement the plan as specified.'
	+ ' The plan file is in your context history; the plan body is NOT.'
	+ ' Read it before you start, do NOT edit the plan file itself, and do NOT create a new plan'
	+ ' — the plan file stays for reference.';
const OLD_DEFAULT = 'The user clicked "Build in Default". ' + OLD_BASE;
const OLD_MULTI = 'The user clicked "Build in Multi". ' + OLD_BASE;
// Frozen on lib/build.js before the multi handoff sentence was added: any change
// to the Default message is a change to what every Default click says.
const OLD_DEFAULT_SHA256 = '99330228461c0ee002110fbe1fcbc0f2458b49078a5d6f157136a26dcb4a78f4';
const OLD_MULTI_SHA256 = '54a4a8a2c498e361f4ca94bf82bb66368d4d6b9f6186416eaaab47b352c85179';

eq(build.BUILD_PATH, '/api/dsh-cursor-modes/build', 'the Build bridge path is the exact route the card posts to');
ok(Object.isFrozen(build.BUILD_TARGETS), 'BUILD_TARGETS is frozen: a route mapping is not runtime state');
ok(Object.isFrozen(build.BUILD_LABELS), 'BUILD_LABELS is frozen');
eq(JSON.stringify({ ...build.BUILD_TARGETS }), JSON.stringify({ multi: 'multi', default: 'default' }), 'BUILD_TARGETS maps each button to the mode switch stages');
eq(
	JSON.stringify({ ...build.BUILD_LABELS }),
	JSON.stringify({ multi: 'Build in Multi', default: 'Build in Default' }),
	'BUILD_LABELS are the two button labels the user actually pressed'
);
eq(Object.keys(build.BUILD_TARGETS).sort().join(','), 'default,multi', 'exactly two choices exist');

const defaultText = build.buildText('default');
const multiText = build.buildText('multi');

eq(defaultText, OLD_DEFAULT, 'Build in Default renders byte-for-byte as before');
eq(sha256(defaultText), OLD_DEFAULT_SHA256, 'Build in Default\'s sha256 matches the frozen pre-change digest');
eq(defaultText.length, OLD_DEFAULT.length, 'Build in Default keeps its length');
ok(multiText.includes(HANDOFF), 'Build in Multi carries the handoff sentence in full');
eq(count(multiText, HANDOFF), 1, 'Build in Multi carries the handoff sentence exactly once');
ok(!defaultText.includes(HANDOFF), 'Build in Default does not carry the handoff sentence');
ok(!defaultText.includes('When you delegate'), 'Build in Default never mentions delegating');
// The two promises the handoff grew (2026-10-24): the worker is handed its own
// slice of the checklist through `todos`, and the main thread keeps none itself.
ok(
	multiText.includes('its own slice of the checklist as the subagent `todos` argument'),
	'multi hands each worker its checklist slice through the subagent todos argument'
);
ok(
	multiText.includes('do not write your own todo list in this conversation'),
	'multi forbids the main thread from keeping its own todo list'
);
ok(multiText.includes('the main thread assigns work and reports back'), 'multi names who does what: workers work, the main thread assigns');
for (const forbidden of ['slice of the checklist', 'todo list', '`todos`']) {
	ok(!defaultText.includes(forbidden), 'Build in Default never mentions the checklist handoff: ' + forbidden);
}
eq(multiText, OLD_MULTI + ' ' + HANDOFF, 'Build in Multi is the old text plus one space and the handoff');
ok(multiText.includes(OLD_MULTI + ' When you delegate'), 'exactly one space joins the instruction and the handoff — no welding into one command');
eq(multiText.replace(' ' + HANDOFF, ''), OLD_MULTI, 'stripping the tail leaves the old multi text');
// "Multi" is two characters shorter than "Default", so the delta is the tail
// plus one space minus that: anything else means a second edit slipped in.
const LABEL_DELTA = build.BUILD_LABELS.default.length - build.BUILD_LABELS.multi.length;
eq(LABEL_DELTA, 2, 'the label delta is measured, not assumed');
eq(
	multiText.length - defaultText.length,
	1 + HANDOFF.length - LABEL_DELTA,
	'the only differences are the label word and the handoff tail'
);
ok(sha256(multiText) !== OLD_MULTI_SHA256, 'the multi text is no longer the silent pre-change rendering');
eq(sha256(multiText), sha256(OLD_MULTI + ' ' + HANDOFF), 'multi hashes as old multi plus exactly one sentence');
ok(multiText.startsWith('The user clicked "Build in Multi".'), 'multi still opens with the clicked label line');
ok(defaultText.startsWith('The user clicked "Build in Default".'), 'default still opens with the clicked label line');
eq(
	multiText.slice(multiText.indexOf(OLD_BASE)),
	OLD_BASE + ' ' + HANDOFF,
	'the shared base is byte-identical in both messages; only the tail follows it'
);
ok(
	multiText.indexOf(OLD_BASE) < multiText.indexOf(HANDOFF),
	'the base comes before the handoff tail'
);

// --- every promise the base carries survives in BOTH buttons ----------------
for (const promise of [
	'The plan file is in your context history; the plan body is NOT.',
	'Read it before you start',
	'do NOT edit the plan file itself',
	'do NOT create a new plan'
]) {
	ok(defaultText.includes(promise), 'default keeps the promise: ' + promise);
	ok(multiText.includes(promise), 'multi keeps the promise: ' + promise);
}

// --- the message a click leaves behind --------------------------------------
const message = build.buildMessage('default');
eq(message.role, 'user', 'a Build click is a USER message: the switch only applies a staged mode to one');
ok(Array.isArray(message.content) && message.content.length === 1, 'the message is one content part');
eq(message.content[0].type, 'text', 'that part is text');
eq(message.content[0].text, defaultText, 'the message body is buildText(choice)');
eq(message.source.kind, 'cursor-plan', 'the message is stamped as this plugin\'s notice');
eq(message.source.form, 'notice', 'the form is notice, the shape the retired command path used');
eq(message.source.summary, 'The user clicked Build in Default.', 'the summary names the button in the projection');
ok(typeof message.id === 'string' && message.id.length > 0, 'the message carries an id');
const multiMessage = build.buildMessage('multi');
eq(multiMessage.content[0].text, multiText, 'the multi message body is the multi text');
eq(multiMessage.source.summary, 'The user clicked Build in Multi.', 'the multi summary names the multi button');
ok(multiMessage.id !== message.id, 'two clicks are two messages, not one replayed id');

// --- the bridge route -------------------------------------------------------
const routes = build.makeBuildRoutes({ get: () => undefined }, createState());
eq(
	routes.map((route) => route.path).join(','),
	[build.BUILD_PATH, build.PLAN_STATE_PATH].join(','),
	'the build half registers the build POST and the plan-state GET'
);
ok(routes.every((route) => route.kind === 'exact'), 'both build-half routes are exact paths');
eq(routes[0].kind, 'exact', 'the route is exact: a prefix match would swallow neighbours');
eq(routes[0].path, build.BUILD_PATH, 'the route is registered at BUILD_PATH');
eq(typeof routes[0].handler, 'function', 'the route has a handler');

/** The smallest request the handler reads: method, peer address, headers, body. */
function fakeRequest(options) {
	const opts = options || {};
	const body = opts.body === undefined ? Buffer.from('{}', 'utf8') : opts.body;
	return {
		method: opts.method || 'POST',
		socket: { remoteAddress: opts.remote === undefined ? '127.0.0.1' : opts.remote },
		headers: Object.assign({ host: '127.0.0.1:4000' }, opts.headers || {}),
		async * [Symbol.asyncIterator]() {
			yield body;
		}
	};
}
function fakeResponse() {
	const res = { status: 0, headers: undefined, body: '' };
	res.writeHead = (status, headers) => {
		res.status = status;
		res.headers = headers;
		return res;
	};
	res.end = (chunk) => {
		res.body = chunk === undefined ? '' : String(chunk);
		return res;
	};
	res.json = () => JSON.parse(res.body);
	return res;
}
async function callBuild(handler, options) {
	const res = fakeResponse();
	await handler(fakeRequest(options), res);
	return res;
}
const body = (value) => Buffer.from(JSON.stringify(value), 'utf8');

{
	const steered = [];
	const live = build.makeBuildRoutes({ get: (id) => (id === 'live' ? { steer: (m) => steered.push(m) } : undefined) }, createState())[0];
	const res = await callBuild(live.handler, { body: body({ sessionId: 'live', choice: 'multi' }) });
	eq(res.status, 200, 'a live session and a known choice answers 200');
	eq(
	JSON.stringify(res.json()),
	JSON.stringify({ ok: true, value: { sessionId: 'live', choice: 'multi', mode: 'multi', dispatched: false } }),
	'the success body reports the staged mode, and that no plan file was stamped (no planFile sent)'
);
	eq(steered.length, 1, 'the click steers exactly one message');
	eq(steered[0].content[0].text, multiText, 'the steered message is the multi Build text');
	eq(res.headers['content-type'], 'application/json; charset=utf-8', 'the bridge answers JSON, never a transport error');
	eq(res.headers['referrer-policy'], 'no-referrer', 'the bridge sets no-referrer like every other route');
}
{
	const res = await callBuild(build.makeBuildRoutes({ get: () => undefined }, createState())[0].handler, {
		body: body({ sessionId: 'gone', choice: 'default' })
	});
	eq(res.status, 409, 'a session with no live agent is refused');
	eq(res.json().code, 'session-not-live', 'and the refusal has its own code');
	eq(res.json().ok, false, 'a refusal is never reported as ok');
}
{
	const res = await callBuild(build.makeBuildRoutes({ get: () => undefined }, createState())[0].handler, {
		body: body({ sessionId: 'live', choice: 'sideways' })
	});
	eq(res.status, 400, 'an unknown choice is a malformed request');
	eq(res.json().code, 'unknown-choice', 'with the unknown-choice code');
	ok(res.json().message.includes('multi') && res.json().message.includes('default'), 'the refusal lists the valid choices');
}
{
	const handler = build.makeBuildRoutes({ get: () => undefined }, createState())[0].handler;
	eq((await callBuild(handler, { body: Buffer.from('not json', 'utf8') })).json().code, 'malformed-request', 'unparseable JSON is refused before anything else');
	eq((await callBuild(handler, { body: Buffer.from('[]', 'utf8') })).status, 400, 'a JSON array body is refused: a choice needs an object');
	eq((await callBuild(handler, { body: body({ choice: 'default' }) })).json().code, 'malformed-request', 'a missing sessionId is refused');
	eq((await callBuild(handler, { body: body({ sessionId: '', choice: 'default' }) })).status, 400, 'an empty sessionId is refused');
	eq((await callBuild(handler, { body: body({ sessionId: 42, choice: 'default' }) })).status, 400, 'a non-string sessionId is refused');
	// Oversized: the cap exists so a stray large body cannot pin the bridge.
	eq((await callBuild(handler, { body: Buffer.alloc(9000, 32) })).json().code, 'malformed-request', 'an oversized body is refused, not buffered');
}
{
	const handler = build.makeBuildRoutes({ get: () => undefined }, createState())[0].handler;
	const res = await callBuild(handler, { method: 'GET', body: Buffer.from('{}', 'utf8') });
	eq(res.status, 405, 'GET is refused: the bridge is POST only');
	eq(res.json().code, 'method-not-allowed', 'with the method-not-allowed code');
}
{
	// Loopback only: the harness binds loopback today, and this keeps the bridge
	// closed even if that ever changes.
	const handler = build.makeBuildRoutes({ get: () => undefined }, createState())[0].handler;
	const res = await callBuild(handler, { remote: '10.0.0.5', body: body({ sessionId: 'live', choice: 'multi' }) });
	eq(res.status, 403, 'a non-loopback peer is refused');
	eq(res.json().code, 'loopback-only', 'with the loopback-only code');
	const crossSite = await callBuild(handler, {
		body: body({ sessionId: 'live', choice: 'multi' }),
		headers: { 'sec-fetch-site': 'cross-site' }
	});
	eq(crossSite.status, 403, 'a cross-site request is refused even from loopback');
}
{
	const failing = build.makeBuildRoutes({ get: () => ({ steer: () => { throw new Error('boom'); } }) }, createState())[0].handler;
	const res = await callBuild(failing, { body: body({ sessionId: 'live', choice: 'default' }) });
	eq(res.status, 500, 'a failing steer is reported as a 500');
	eq(res.json().code, 'steer-failed', 'with the steer-failed code');
	eq(res.json().message, 'boom', 'the refusal carries the real reason');
}

// ===========================================================================
// summary
// ===========================================================================
for (const failure of failures) console.error('FAIL: ' + failure);
console.log('self-check-policy: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length > 0) process.exit(1);
