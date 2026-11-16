/**
 * 多任务（multitask）模式的接线：`mode:policy` 段（order 501）与
 * `agent/pre-step` 的模式落地。
 *
 * ## 这个文件现在只剩两件事
 *
 * - 501 这个空槽：`MODE_RULES`（prompts.js）由 `cursorPlan:policy`（502）渲染，
 *   两段返回同一个常量会把规则打印两遍。槽位保留、内容为空，段顺序因此不变。
 * - 模式落地：chip 只 stage，`agent/pre-step` 在递送用户自己那条消息的步上提交
 *   （口径 S1），`commitPending` 是唯一的写法。
 *
 * ## 2026-11-16：工具调用额度整段删除
 *
 * 这里原本还有每 Agent 的调用额度闸、`request_more_edits` 工具、两条额度通知
 * 和 `agent/inbox/claimed` 的唤醒观察器（连同 `lib/gate.js`）。额度机制按决定
 * 整个拿走：没有账、没有拒绝、没有申请通道，约束改由提示词承担（"一切派单"）。
 * 只剩一句历史注释，不再有活代码引用。
 *
 * @module dsh-cursor-modes/multi
 */

import { commitPending } from './state.js';

/**
 * The `agent/pre-step` half: commit a staged switch when this step delivered the
 * user's own message (口径 S1).
 *
 * @param {object} host
 * @param {object} state
 * @param {{ session: object }} agent
 * @param {{ aborted?: boolean }} [signal]
 * @param {object} decision
 * @returns {object} the decision to hand on
 */
export function commitMultiMode(host, state, agent, signal, decision) {
	if (decision?.kind === 'reject') return decision;
	return commitPending(host, state, agent, decision, signal, { requireUserMessage: true });
}

/**
 * Register what multi mode owns on the host: the empty `mode:policy` section.
 *
 * The section order stays 501 (blueprint §4.3): just past the official
 * `plan:policy` (500) and before `team:policy` (600), byte-identical to what
 * `dsh-modes` produced for any multi-only session.
 *
 * @param {object} host context carrying `systemPrompt`
 */
export function wireMulti(host) {
	host.systemPrompt.section({
		name: 'mode:policy',
		order: 501,
		// 2026-10-29 (stable prefix): the multiline text moved into prompts.js
		// MODE_RULES, which `cursorPlan:policy` (order 502) renders. This slot stays
		// registered and empty rather than removed, so the section order is unchanged;
		// two sections returning the same constant would render the rules twice.
		text: () => ''
	});
}
