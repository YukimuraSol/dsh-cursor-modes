/**
 * The model-facing prompt text for the `plan` mode this plugin owns.
 *
 * 2026-10-24 (planv4): the entry set and `create_plan`'s description are this
 * harness's own wording, replacing the verbatim Cursor transcript. The plan's
 * shape is sketched ONCE, in one prose paragraph inside ENTRY_PROMPT: a rough
 * "that is usually all a plan needs" shape instead of a mandatory section list,
 * because a fixed form is what the model ignored.
 *
 * 2026-10-24 (one plan section): plan mode renders ONE section for its whole
 * life. It used to serve a second "continuation" set once the request header
 * already carried the mode. Two sets meant two different system-prompt sections
 * per plan session, and the switch billed the new one as a cache miss twice:
 * entering plan cost ~2,400 extra miss tokens, with the hit rate stuck at 88%
 * on the second request instead of returning to 99%. ENTRY_PROMPT now also
 * carries the one continuation rule that mattered -- later feedback revises the
 * plan, only the user changes the mode -- so the model sees the same bytes on
 * every turn and the section stays cached.
 *
 * The mutually exclusive upstream variants (the GPT-5 `<begin_plan_mode/>` set,
 * the composer2 long continuation, the new entry sets, `10. Current plan mode
 * progress`, `<concrete_plans>`) stay absent — self-check-policy asserts it.
 *
 * @module dsh-cursor-plan/prompts
 */

/**
 * The write-exemption paragraph the plan section carries. It names `create_ui_block`,
 * a tool a deployment may not have installed, so the section swaps in the
 * tool-free wording when `host.tools.get` does not resolve it. The two variants
 * differ only in that one half-sentence.
 */
export const UI_BLOCK_SENTENCE = `Two kinds of writes are not execution and are allowed. Creation goes through the
artifact's own tool: \`create_plan\` for the plan document, \`create_ui_block\` for a UI
draft under \`~/.dsh/ui-blocks/\`. Revision goes in place with \`write\` or \`edit\`: the plan
document itself, or an existing \`~/.dsh/ui-blocks/*.uiblock\`. Both are planning material.
Everything else stays read-only.`;

/**
 * The same paragraph with the ui-block half-sentence removed, for a deployment
 * where `create_ui_block` is not installed: naming an absent tool only invites
 * the model to call it.
 */
export const UI_BLOCK_SENTENCE_WITHOUT_TOOL = `Two kinds of writes are not execution and are allowed. Creation goes through the
artifact's own tool: \`create_plan\` for the plan document. Revision goes in place with \`write\` or \`edit\`: the plan
document itself, or an existing \`~/.dsh/ui-blocks/*.uiblock\`. Both are planning material.
Everything else stays read-only.`;

/**
 * The plan section: the mode's one and only prompt text, rendered on the request
 * that first carries the switch and on every turn after it. Exactly one set is
 * what keeps the system prompt byte-stable, so the section stays in the
 * provider's prompt cache instead of being re-billed on the switch.
 * The eleven numbered rules are the mode's contract. One prose paragraph below
 * them sketches the plan's shape — a title, 整体概览, 技术细节, and the todos
 * checklist — and allows one extra section when the change needs it. One more
 * paragraph fixes the voice: plain and declarative, never colloquial.
 * Substitution: the UI_BLOCK_SENTENCE placeholder -> the write-exemption
 * paragraph.
 */
export const ENTRY_PROMPT = `<system_reminder>
Plan mode is active. The user does not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise change the system. This supersedes any other instructions.

1. Search to gather what an accurate plan needs.

2. Ask with ask_user_question when information is missing or ambiguous — including when several implementations would each change the plan significantly; 1-2 questions, at the very start.

3. Never ask whether to start work, and never ask where code lives or how current behavior works: those you look up.

4. Write 不确定 rather than inventing a fact.

5. To speed up research, explore with parallel read-only subagents via the subagent tool.

6. Present it by calling the create_plan tool. Do not call exit_plan_mode: this deployment does not install it.

7. A conversational yes approves nothing. Fold the confirmed decision into the plan and submit again. Later feedback revises the plan: fold it into the plan document rather than executing. Only the user can change the mode.

8. Do not use todo_write during planning: it tracks implementation of an approved plan.

9. Do not paste the plan body into your reply; the card links to it.

10. Keep the plan proportional to the request.

11. Every question to the user goes through the ask_user_question tool.

Plan shape, roughly: a \`#\` title, then \`## 整体概览\` — what will be different and what the user will notice — then \`## 技术细节\` — the anchors, one line each, \`file:line\`, what it is now → what it becomes, how to verify. That is usually all a plan needs; an extra section is fine when the change really needs one, but keep it short. The checklist is the \`todos\` argument, which the card renders as 执行清单: one sentence per item, unique id, status \`pending\`. To change the plan later, read and edit the file itself; calling the tool again creates a second file.

Language: plain and declarative. Concise is not colloquial — state what is true and what will change; no spoken asides, no rhetorical questions, no 说白了 / 其实 / 你看, no second-person chat, no hype.

${UI_BLOCK_SENTENCE}

<mermaid_syntax>
No spaces in node ids (\`userService\`). Quote labels containing punctuation (\`A -->|"O(1)"| B\`) and node labels with specials (\`A["Step 1: Init"]\`). Avoid reserved ids: \`end\`, \`subgraph\`, \`graph\`, \`flowchart\`. Subgraphs need an id (\`subgraph auth [Auth]\`). No angle brackets or HTML entities, no colors or styles, no \`click\`.
</mermaid_syntax>
</system_reminder>`;


/**
 * create_plan's model-facing description — deliberately short. The plan's shape
 * is specified by the plan_document block in ENTRY_PROMPT, so this text only
 * says when to call the tool, that the first line is the title, and that the
 * checklist is the todos ARGUMENT the card renders below the body. Repeating a
 * body rule here would be a second spec that could drift from the first.
 */
export const CREATE_PLAN_DESCRIPTION = `Use this tool to create a concise plan for accomplishing the user's request. Call it at the end of the planning phase, once the shape of the change is settled, to finalize and store the plan.

The first line MUST BE A TITLE formatted as a level 1 markdown heading; a plan without one is rejected. The document's shape is fixed by the plan-mode instructions.

\`todos\` is part of the plan: the card renders it below the body as 执行清单, one sentence per item with a unique id and a status that is always "pending" for a plan that has not run.`;

/**
 * Pick the section text for the current mode state. Empty when inactive, so
 * renderPrompt drops the section entirely and an unused mode costs zero tokens.
 *
 * Plan mode gets ENTRY_PROMPT on EVERY request. `modeAtHeader` is still
 * accepted because the section API hands it over on every render, but it no
 * longer selects anything: a set that changed once the header already carried
 * the mode split the section in two, and the provider re-billed the new one as a
 * cache miss twice per entry (~2,400 miss tokens measured). Keeping one set loses
 * nothing that matters — the continuation rule that did (later feedback revises
 * the plan, only the user changes the mode) is in ENTRY_PROMPT — and if the model
 * ever reads feedback as a go-ahead, the gate still refuses every non-readonly
 * call.
 *
 * @param {string | null} mode Folded (or pending) mode.
 * @param {string | null} modeAtHeader Mode the last request header described.
 *   Accepted, not consulted: the plan text does not vary with it.
 * @returns {string}
 */
export function policyText(mode, modeAtHeader) {
	if (mode !== 'plan') return '';
	return ENTRY_PROMPT;
}
