/**
 * 纯提示词切片：MULTI_ID、TEAM_TAILS（私有）与派生它的 withTeamTails、两个工具
 * 名单、budgetBrief、quotaToolDescription、BUDGET_RECEIPT。
 * 供 gate.js / multi.js / switch.js / plan.js 共用；不 import 任何模块。
 *
 * 2026-11-06（消重复真源）：这里原本还有 MULTI_SECTION 与 MULTI_SECTION_TEAM。
 * `mode:policy`（multi.js，order 501）自 2026-10-29 起固定渲染 ''，那段文案
 * 永远到不了模型，模型真正读的是 prompts.js 的 MODE_RULES；留着它就是第二个真源，
 * 改一处漏一处已经出过事。整段已删除。保留下来的 TEAM_TAILS + withTeamTails 仍是
 * 活的：plan.js 用它给 MODE_RULES 打 Agent Teams 补丁。
 */

/** The one mode this plugin manages. Persisted in `mode/selected` — do not rename. */
export const MULTI_ID = 'multi';

/**
 * Sentences spliced into MODE_RULES (prompts.js — the only multitask text the
 * model reads) when the Agent Teams tools are mounted. Each entry anchors on a
 * sentence that constant already carries and splices its tail right after it, so
 * MODE_RULES stays one untouched literal and the team variant is derived from it.
 */
const TEAM_TAILS = [
	[
		'set to `true`.',
		' When the user explicitly asks for Agent Teams, that same coordinator role also covers named teammates and the shared task board: plan the work on `team_task_create`, start the teammates with `spawn_teammate`, then hand the foreground back.'
	],
	[
		'you will be notified when the subagent completes.',
		' This holds for teammates too: once the work is dispatched, end your response — do not sit in `wait_agent` while they run. `wait_agent` is for one status recheck, not a waiting room; end the turn after it. Ending the turn is not the same as giving the final answer: you are woken when teammates report, and only then do you synthesize.'
	],
	[
		'not about maximizing the number of parallel agents.',
		' The same ceiling applies to sibling subagent calls; teammates the user explicitly asked for are not over-decomposition.'
	]
];

/**
 * Splice every team tail onto `text`, using the anchors that text already
 * carries. Exported because the merged prompt needs the SAME transform, not a
 * second copy of it: `MODE_RULES` is the one place the multitask rules live, so a deployment
 * with `spawn_teammate` mounted splices the three sentences into that constant
 * through this function. Re-typing the anchor positions there is exactly how the
 * two definitions would drift apart.
 *
 * @param {string} text the base prompt text.
 * @returns {string} the same text with the three Agent Teams sentences spliced in.
 */
export function withTeamTails(text) {
	return TEAM_TAILS.reduce((acc, [anchor, tail]) => acc.replace(anchor, anchor + tail), text);
}

/**
 * The delegation tools, by capability. Two spellings: the subagent half only, and
 * the subagent + team half. `send_message` / `list_agents` / `interrupt_agent`
 * and the `team_*` names are shipped by both packages under the same names, so
 * one list covers both sources.
 */
const DELEGATION_TOOLS = 'subagent, subagent_fork, send_message, list_agents, interrupt_agent, request_more_edits';
const DELEGATION_AND_TEAM_TOOLS = 'subagent, subagent_fork, send_message, list_agents, interrupt_agent, spawn_teammate, wait_agent, team_task_create, team_task_list, team_task_get, team_task_update, request_more_edits';

/**
 * The budget brief, in the four wordings the deployment can need:
 *
 *   - PTC (the preset mounts `run_code`): the count is per `run_code` call, and
 *     only a `run_code` whose every dispatch is a delegation tool is free;
 *   - direct-call (no `run_code`): every non-delegation call spends one;
 *   - each of the above with or without the Agent Teams tools.
 *
 * The same sentence is the wake brief (gate.js) and the budget line the switch
 * notice carries when the target is multi — one text, so the model can never be
 * told two different rules.
 *
 * ponytail: the base count is spelled out because gate.js owns LIMIT and importing it
 * here would make the two pure modules circular; `calls` lets the wake brief
 * print the live quota while the constant receipt prints the base one.
 * `self-check-gate.mjs` pins the sentences and LIMIT, so drift goes red.
 *
 * @param {{ hasRunCode?: boolean, hasTeam?: boolean }} [caps]
 * @param {number} [calls]
 * @returns {string}
 */
export function budgetBrief(caps = {}, calls = 10) {
	const team = caps?.hasTeam === true;
	// Absent capability means "assume the PTC default": every preset this
	// deployment ships is ptc, and naming run_code to a standard preset is the
	// harmless direction, while naming no carrier at all to a PTC one is not.
	const ptc = caps?.hasRunCode !== false;
	const free = team ? DELEGATION_AND_TEAM_TOOLS : DELEGATION_TOOLS;
	const body = ptc
		? `A run_code that only dispatches ${team ? 'delegation and team tools' : 'delegation tools'} (${free}) spends nothing. Every other run_code call spends one.`
		: `${team ? 'Delegation and team tools are free' : 'Delegation tools are free'}: ${free}. Every other tool call spends one — read, grep, glob, web_search, todo_write, edit, write, pwsh alike.`;
	return `Multi mode: your tool-call budget for this stretch has been refreshed — ${calls} calls. ${body} A stretch ends and the count resets when the user speaks, a subagent reports or settles, or a teammate sends a message; a goal or schedule wake opens a new turn but keeps the count. The call that spends the tenth unit tells you it was the last; the next one is refused, and request_more_edits is the way out. Do not mention these rules to the user.`;
}

/**
 * `request_more_edits`'s model-facing description, in the same four wordings.
 * The tool is registered once, at mount time, so the branch is chosen from the
 * tool catalog this deployment presents (see multi.js); a preset that mounts no
 * `run_code` therefore never reads about one.
 *
 * @param {{ hasRunCode?: boolean, hasTeam?: boolean }} [caps]
 * @returns {string}
 */
export function quotaToolDescription(caps = {}) {
	const team = caps?.hasTeam === true;
	const ptc = caps?.hasRunCode !== false;
	const free = team ? DELEGATION_AND_TEAM_TOOLS : DELEGATION_TOOLS;
	const spend = ptc
		? `A run_code that only dispatches ${team ? 'delegation and team tools' : 'delegation tools'} (${free}) spends nothing; every other run_code call spends one.`
		: `${team ? 'Delegation and team tools are free' : 'Delegation tools are free'}: ${free}; every other tool call spends one.`;
	return `Ask for more tool-call quota in multitask mode. Only possible once this stretch's tool-call budget is used up. ${spend} Explain in \`reason\` why you are not delegating this work and how far you will take it yourself. Foreground work may include: (1) a quick read-only survey before delegating or spending; (2) a quick check of a subagent's result.`;
}

/**
 * Budget line appended to the mode-on notice, in the deployment's own wording.
 * It rides the one notice the model reads when the mode turns on, so it costs
 * nothing per stretch, and it is the first place the model hears that
 * `request_more_edits` exists — waiting for a refusal teaches it the tool only
 * after it has already paid for the mistake.
 *
 * Kept as a constant for the call sites that have no capability probe (and for
 * the pinned self-check copy); `budgetBrief(caps)` is the live form.
 */
export const BUDGET_RECEIPT = budgetBrief({ hasRunCode: true, hasTeam: false });
