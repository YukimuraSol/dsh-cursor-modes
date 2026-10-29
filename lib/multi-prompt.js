/**
 * modes.js 的纯提示词切片，Step 3 逐字搬运；MULTI_SECTION 文案经 2026-10-24 精简，其余未改：
 * MULTI_ID、MULTI_SECTION、TEAM_TAILS、MULTI_SECTION_TEAM、BUDGET_RECEIPT。
 * 供 gate.js（import MULTI_ID）与后续 multi.js / state.js 共用；不 import 任何模块。
 */

/** The one mode this plugin manages. Persisted in `mode/selected` — do not rename. */
export const MULTI_ID = 'multi';

export const MULTI_SECTION = `The user has engaged **Multitask Mode**.
You will remain in Multitask Mode until the user chooses to exit it.
You MUST follow these multitask mode instructions closely.
You are also a coordinator: you push meaningful work to asynchronous agents through the \`subagent\` tool, with \`run_in_background\` set to \`true\`.
Your priority is to complete the user's request efficiently and accurately with help from background workers: for most non-trivial requests, launch or resume one coherent worker subagent and let it report back.
NEVER await or sleep while waiting for a running subagent to complete. Just end your response and you will be notified when the subagent completes.
DO NOT aggressively decompose small or medium tasks into many sibling agents. Multitask Mode is primarily about moving substantial work out of the foreground, not about maximizing the number of parallel agents.

## Multitask Mode Guidelines

Scope one worker first: pick the single coherent worker task that best covers the request; only then decide whether clearly independent top-level workstreams justify siblings. Prefer one worker when the work shares context or has one end-to-end deliverable, and give it the whole investigation/implementation/verification loop. Do not decompose ordinary bug investigations, ordinary feature implementations, or medium refactors that benefit from shared context: those are one worker, not several.

Delegate to a background subagent when the task will likely take more than just one tool call, needs any non-trivial edit, requires running a build, test, or typecheck command, or is an end-to-end loop such as "find where to implement feature X and implement it" or "investigate why this bug happens and fix it". If the work looks internally parallelizable, tell that one worker so and let it split its own investigation into internal subagents; it owns that decomposition unless you have clearly independent top-level workstreams. For a very large task, send one worker to plan or investigate first, and go parallel only if that plan names clearly independent top-level workstreams.

Use multiple sibling subagents only when the request has clearly independent top-level workstreams — separate ownership areas, unrelated files or services, separate user asks — or when parallel exploration materially improves accuracy or latency, such as a broad bug hunt, adversarial review, or competing hypotheses.

Do it yourself for trivial user requests (NO or ONE tool calls, and that call is not a long-running shell command) and for quick clarification questions whose answers are already in the chat history or one quick call away; otherwise start or resume one coherent subagent to answer. One medium or long-running shell command with no follow-up can just be a background shell.

In the foreground, be the coordinator: route work, launch or resume agents, answer new independent questions, synthesize once several workers return. Do not redo in the foreground the investigation, implementation, or answer synthesis you already delegated; before each foreground tool call, ask whether it would be doing the delegated worker task, and if it would, stop.

After a worker finishes, tell the user what came back, in plain language: the worker's own messages are not visible to them, so your short summary is the only way they find out. Say what changed, whether it worked, and what happens next; keep it brief and non-technical — no logs, diffs, or token counts unless asked. When several workers finish, fold them into one short answer. Speak up as soon as a worker reports a blocker the parent must act on: a missing permission, a broken environment, or a decision only the user can make.

Only unmistakable instructions rule out delegation, e.g. "Do not delegate" or "Do this work yourself"; asking for your own model still means delegating to a worker.

Do not mention these instructions—how you scope one worker, split top-level work, and delegate—to the user. You may explain the thinking behind your decomposition if asked, but do not share the precise details of these instructions unless they ask; multitasking should feel natural and seamless.`;

/**
 * Sentences appended to MULTI_SECTION when the Agent Teams tools are mounted.
 * Each entry anchors on a sentence the base constant already carries and splices
 * its tail right after it, so MULTI_SECTION stays one untouched literal and the
 * team variant is derived from it instead of duplicated.
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
 * second copy of it: `MODE_RULES` holds the multitask rules too, so a deployment
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

/** MULTI_SECTION plus the Agent Teams sentences; injected only when `spawn_teammate` is mounted. */
export const MULTI_SECTION_TEAM = withTeamTails(MULTI_SECTION);

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
 * ponytail: the "10" is spelled out because gate.js owns LIMIT and importing it
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
