/**
 * 纯提示词切片：MULTI_ID、TEAM_TAILS（私有）与派生它的 withTeamTails。
 * 供 multi.js / switch.js / plan.js / state.js 共用；不 import 任何模块。
 *
 * 2026-11-06（消重复真源）：这里原本还有 MULTI_SECTION 与 MULTI_SECTION_TEAM。
 * `mode:policy`（multi.js，order 501）自 2026-10-29 起固定渲染 ''，那段文案
 * 永远到不了模型，模型真正读的是 prompts.js 的 MODE_RULES；留着它就是第二个真源，
 * 改一处漏一处已经出过事。整段已删除。
 *
 * 2026-11-16（删额度）：budgetBrief / quotaToolDescription / BUDGET_RECEIPT 与
 * 两份委派工具名单随工具调用额度机制一起删除 —— 模型不再有「还剩几次」这回事。
 * 保留下来的 TEAM_TAILS + withTeamTails 仍是活的：plan.js 用它给 MODE_RULES 打
 * Agent Teams 补丁。
 */

/** The one mode this plugin manages. Persisted in `mode/selected` — do not rename. */
export const MULTI_ID = 'multi';

/**
 * Sentences spliced into MODE_RULES (prompts.js — the only multitask text the
 * model reads) when the Agent Teams tools are mounted. Each entry anchors on a
 * sentence that constant already carries and splices its tail right after it, so
 * MODE_RULES stays one untouched literal and the team variant is derived from it.
 *
 * The anchors are English sentences the constant keeps verbatim on purpose: the
 * rewrite of the multitask section may change everything around them, but a
 * missing anchor makes withTeamTails() silently splice nothing, so
 * self-check-runtime pins one occurrence per anchor.
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
