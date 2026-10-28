/**
 * Plan mode's half of `dsh-cursor-modes`: the `cursorPlan:policy` section
 * (order 502), the `create_plan` tool, the markdown edit gate, the plan-mode
 * delegation branch, and the `cursorPlan/planDoc` append.
 *
 * Moved here from `dsh-cursor-plan/lib/index.js` (blueprint §1.5, §4.2):
 *
 *   isMarkdown / isExistingUiBlock / isPlanFile / planWritePath / planModeBlock   :176-233
 *   delegationBlock                                                              :252-303
 *   firstHeading                                                                 :306-311
 *   section `cursorPlan:policy` order 502                                        :435-449
 *   `create_plan` registration                                                  :457-540
 *   `agent/pre-step` pending commit                                              :421-433
 *   `tools/post-execute` planDoc append                                          :561-584
 *
 * ## Boundary discipline (blueprint §1.5)
 *
 * - This file READS `state.pending` only, and only through
 *   {@link selectedMode} — `state.js` is the one writer, and I2 forbids reading
 *   `stateOf(session, 'mode').mode` here.
 * - This file registers the section and the tool in {@link wirePlan}; it never
 *   calls `host.on`. The three hook bodies (pre-step commit / pre-execute gate /
 *   post-execute append) are exported as plain functions so `index.js` owns the
 *   single registration point of each hook.
 *
 * @module dsh-cursor-modes/plan
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { PLAN_DOC_EVENT, PLAN_MODE_ID, PLAN_TOOL, judgeBackend } from './cursor-plan.js';
import { GATE_TOOLS, gateDelegation } from './delegation-gate.js';
import { writePlanFile } from './planfile.js';
import { MODE_KEY } from './projection.js';
import { CREATE_PLAN_DESCRIPTION, UI_BLOCK_SENTENCE, UI_BLOCK_SENTENCE_WITHOUT_TOOL, policyText } from './prompts.js';
import { commitPending, loggedMode, selectedMode } from './state.js';

/**
 * Extensions whose edits stay legal in plan mode: the plan document itself.
 * Plan mode restricts edits to the artifact it produces, not to "writes the
 * plan tool performs" — the model edits the plan file directly to iterate.
 */
const PLAN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx'];

/** Write-shaped tools and the argument naming the file they will change. */
const WRITE_TOOLS = [
	{ name: 'write', field: 'file_path' },
	{ name: 'edit', field: 'file_path' },
	{ name: 'str_replace_editor', field: 'path', commands: ['create', 'str_replace', 'insert'] }
];

/** True when `path` names a markdown file. */
export function isMarkdown(path) {
	const lower = String(path).toLowerCase();
	return PLAN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * True when `path` is an EXISTING .uiblock draft under the active Harness home
 * (added 2026-10-17). Boundary check, not a suffix check: `../../x.uiblock`
 * cannot escape the dir. Creation stays `create_ui_block`'s job (it registers
 * the block); only the in-place revision of an existing draft is a plain edit.
 */
export function isExistingUiBlock(path) {
	if (typeof path !== 'string' || !path.toLowerCase().endsWith('.uiblock')) return false;
	const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
		? process.env.DSH_HOME
		: join(homedir(), '.dsh');
	const dir = resolve(join(home, 'ui-blocks'));
	const abs = resolve(path);
	if (!abs.startsWith(dir + sep)) return false;
	try { return statSync(abs).isFile(); } catch { return false; }
}

/** True when `path` is a create_plan landing file (`*.plan.md`). */
export function isPlanFile(path) {
	return typeof path === 'string' && path.toLowerCase().endsWith('.plan.md');
}

/**
 * Absolute path of a WRITE_TOOLS call that mutates a `.plan.md`, or `undefined`.
 * Same command filter as the plan-mode gate (`view` is not a mutation).
 */
export function planWritePath(exec) {
	const write = WRITE_TOOLS.find((tool) => tool.name === exec.name);
	if (write === undefined) return undefined;
	const args = exec.arguments;
	if (typeof args !== 'object' || args === null) return undefined;
	if (write.commands !== undefined && !write.commands.includes(args.command)) return undefined;
	const path = args[write.field];
	return isPlanFile(path) ? path : undefined;
}

/**
 * Would this call change a file outside the planning material (the plan document
 * or an existing `.uiblock` draft)? Returns the blocking reason, or `undefined`
 * to allow. Shell tools are deliberately not covered: this is the markdown-edit
 * gate, not a general sandbox.
 */
export function planModeBlock(exec) {
	const write = WRITE_TOOLS.find((tool) => tool.name === exec.name);
	if (write === undefined) return undefined;
	const args = exec.arguments;
	if (typeof args !== 'object' || args === null) return undefined;
	if (write.commands !== undefined && !write.commands.includes(args.command)) return undefined;
	const path = args[write.field];
	if (isMarkdown(path)) return undefined;
	if (isExistingUiBlock(path)) return undefined;
	return `Plan mode is active, so only planning material may be edited: the plan document (${PLAN_EXTENSIONS.join(', ')}) or an existing UI draft under ~/.dsh/ui-blocks/ (*.uiblock; create new ones with create_ui_block). ${exec.name} on ${typeof path === 'string' && path !== '' ? path : 'that target'} is blocked until the user approves the plan. Iterate on the plan file itself, or ask the user to Build. Only the user can change the mode; the official exit_plan_mode tool is not available here.`;
}

/**
 * The route the LLM judge asks on: the session's own provider and the session's
 * own model, and nothing else.
 *
 * `model` is not read here on purpose. It is the JEV connection's model id — the
 * decision model the judge is asked with — so a deployment that filled the JEV
 * connection in has a model id no chat provider can serve. Following the session
 * means following it exactly: the branch that needs no connection must not read
 * one, or a saved JEV route would silently break the follow branch.
 *
 * @param {object} host
 * @param {object} exec
 * @returns {{ llm: object | undefined, provider: string, model: string }}
 */
function llmRouteOf(host, exec) {
	const config = exec.agent?.session?.requestHeader?.()?.config;
	const provider = typeof config?.provider === 'string' ? config.provider : '';
	const sessionModel = typeof config?.model === 'string' ? config.model : '';
	return { llm: host.get('llm'), provider, model: sessionModel };
}

/**
 * Plan-mode delegation branch, ahead of the markdown write gate. Both gated
 * tools — `subagent` and `send_message` — are judged read-only first. Off
 * unless the deployment enables the gate.
 *
 * `gateOf` is read per judged call, so a settings-card edit reaches the next
 * delegation without a restart; it falls back to the composed config until the
 * settings namespace is registered.
 *
 * ponytail: the credential is resolved per call and never cached, so a rotated
 * key reaches the next delegation; the ceiling is one resolve per judged call.
 *
 * @param {object} host
 * @param {object} exec
 * @param {() => object} gateOf Effective gate values for this call.
 * @param {{ last: object | null }} [verdicts] Receives the outcome, in memory only.
 * @returns {Promise<string | undefined>} Deny reason, or `undefined` to fall
 * through to the markdown gate.
 */
export async function delegationBlock(host, exec, gateOf, verdicts) {
	const gate = gateOf();
	if (!gate.enabled) return undefined;
	if (!GATE_TOOLS.includes(exec.name)) return undefined;
	// The judge backend is read per judged call, so a settings-card edit reaches
	// the next delegation. An unknown value lands on `jev`, reported once here.
	const backend = judgeBackend(gate.backend);
	if (backend !== gate.backend) {
		host.logger.warn('dsh-cursor-modes: unknown gate.backend %o, judging with jev', gate.backend);
	}
	// The LLM backend needs no judge credential at all: it asks the session's own
	// model through the host `llm` service, so nothing is resolved on that path —
	// and, on purpose, neither the key nor the endpoint below is even read, so a
	// JEV connection saved in the settings can never leak into the follow branch.
	let apiKey;
	let baseUrl;
	if (backend !== 'llm') {
		// The card's own connection row wins: a key stored as plain text in the
		// plugin config is what the reader just pasted. Only when it is empty does
		// the older credential reference get a say, which keeps every deployment
		// that never opens the card working exactly as before.
		apiKey = typeof gate.apiKey === 'string' ? gate.apiKey.trim() : '';
		if (apiKey === '') {
			try {
				apiKey = (await host.get('credentials')?.resolve(gate.apiKeyRef))?.value;
			} catch (error) {
				host.logger.warn('dsh-cursor-modes: delegation gate could not resolve %s: %o', gate.apiKeyRef, error);
			}
		}
		baseUrl = gate.baseUrl;
	}
	const route = backend === 'llm' ? llmRouteOf(host, exec) : undefined;
	// An empty `model` leaves each backend on its own default route, which is what
	// keeps a deployment that never sets one byte-identical to the JEV-only build.
	const model = backend === 'llm'
		? route?.model
		: (typeof gate.model === 'string' && gate.model !== '' ? gate.model : undefined);
	const verdict = await gateDelegation({
		exec,
		apiKey,
		model,
		baseUrl,
		timeoutMs: gate.timeoutMs,
		limits: { allowConfidence: gate.allowConfidence, workReject: gate.workReject },
		backend,
		llm: route?.llm,
		provider: route?.provider,
		signal: exec.signal
	});
	// The settings card's status line: the last judgement, never persisted and
	// never carrying the credential or the judged task text.
	if (verdicts !== undefined) verdicts.last = { allow: verdict.allow, reason: verdict.reason, backend, at: Date.now() };
	// One host log line per judgement, so a restart no longer erases the trail.
	// The numbers come from `verdict.audit` (never parsed back out of `reason`);
	// a branch with no audit — an empty payload, or an unreachable judge — logs
	// its reason instead. The credential and the judged task text are absent.
	const audit = verdict.audit;
	// The JEV line is unchanged, byte for byte, so an existing log trail still
	// greps the same; the LLM backend logs its own verdict and the model it used.
	const trail = backend === 'llm'
		? [
			'dsh-cursor-modes: delegation gate allow=%s backend=llm verdict=%s model=%s%s',
			verdict.allow,
			audit?.verdict ?? 'n/a',
			model ?? 'n/a',
			audit === undefined ? ` reason=${verdict.reason}` : ''
		]
		: [
			'dsh-cursor-modes: delegation gate allow=%s intent=%s confidence=%s change-probability=%s%s',
			verdict.allow,
			audit?.intent ?? 'n/a',
			audit?.confidence ?? 'n/a',
			audit?.work ?? 'n/a',
			audit === undefined ? ` reason=${verdict.reason}` : ''
		];
	// Neither sink may cost the judgement, so each one stands alone.
	try {
		host.logger.info(...trail);
	} catch {
		// ponytail: the logger's ring buffer is best-effort by construction.
	}
	// The deployment registers no logger exporter (cordis keeps an in-memory ring
	// buffer only), so the same line also goes to stderr — the sink the host log
	// file already captures. ponytail: stderr makes that file grow with every
	// judgement; swap in a rotating exporter (a daily split) when it matters.
	try {
		console.error(...trail);
	} catch {
		// ponytail: a closed stderr is not a judgement failure.
	}
	if (verdict.allow) return undefined;
	return `Plan-mode delegation gate: ${verdict.reason}. Plan mode allows delegation for the plan's read-only investigation only, so do that investigation yourself, or wait until the user changes the mode.`;
}

/** The plan's first markdown heading (any level), or `undefined` when it has none. */
function firstHeading(plan) {
	for (const line of String(plan).split('\n')) {
		const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		if (match) return match[1];
	}
}

/** The mode the last logged request header was assembled with. */
function modeAtHeaderOf(host, session) {
	return host.sessionProjections.stateOf(session, MODE_KEY)?.modeAtHeader ?? 'default';
}

/**
 * Commit a mode selected while a turn was open, for the plan side.
 *
 * Delegates to {@link commitPending}: the merged machine has ONE pending map, so
 * the plan commit and the multi commit are the same operation. Kept as a named
 * seam because `index.js` calls the two sides separately (blueprint §4.2: one
 * `agent/pre-step` handler, internally two calls), and because a future
 * plan-only condition belongs here rather than in the shared writer.
 *
 * @param {object} host
 * @param {object} state
 * @param {{ session: object }} agent
 * @param {{ aborted?: boolean }} [signal]
 * @param {{ kind?: string }} decision
 * @returns the decision to hand on, unchanged.
 */
export function commitPlanMode(host, state, agent, signal, decision) {
	// S1: the staged mode lands only on a step that delivered the user's own
	// message, and the shared writer appends the one switch notice when it does.
	return commitPending(host, state, agent, decision, signal, { requireUserMessage: true });
}

/**
 * After a successful `.plan.md` mutation, publish the on-disk body so the client
 * turnTail card can refresh (`create_plan` alone only settles once).
 *
 * Pure side effect: `session.append(PLAN_DOC_EVENT, …)`. Nothing is returned and
 * no decision is rewritten — the caller's `additionalContexts` must survive
 * untouched (blueprint §4.6).
 *
 * @param {object} host
 * @param {object} exec the executed call
 * @param {object} result the tool result (`isError === true` skips)
 * @param {object} [state] the single state bag; without it the logged mode is
 *   used, which drops only the still-pending switch window.
 */
export function appendPlanDoc(host, exec, result, state) {
	if (result?.isError === true || exec?.agent === undefined) return;
	const session = exec.agent.session;
	const mode = state === undefined
		? loggedMode(host, session)
		: selectedMode(host, state, session);
	if (mode !== PLAN_MODE_ID) return;
	const path = planWritePath(exec);
	if (path === undefined) return;
	const turn = host.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn;
	if (typeof turn !== 'number' || turn <= 0) return;
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		host.logger.warn('dsh-cursor-modes: failed to read plan file after edit: %o', error);
		return;
	}
	try {
		session.append(PLAN_DOC_EVENT, { turn, path, plan: text });
	} catch (error) {
		host.logger.warn('dsh-cursor-modes: failed to append planDoc after edit: %o', error);
	}
}

/**
 * Register what plan mode owns on the host: the `cursorPlan:policy` section and
 * the `create_plan` tool.
 *
 * The section order stays 502 (blueprint §4.3): that puts it just past the
 * official `plan:policy` (500) and before `team:policy` (600), and it is
 * byte-identical to what `dsh-cursor-plan` produced for any plan-only session —
 * a different number would only introduce a prompt drift nobody can explain.
 *
 * The tool is registered UNCONDITIONALLY so the request tool catalog is constant
 * across mode switches: a toggled catalog flushes the KV cache from the first
 * changed schema token. An inactive mode costs the schema on every request,
 * never a cache flush.
 *
 * @param {object} host context carrying `systemPrompt`, `tools`, `sessionProjections`
 * @param {object} state the single state bag from `createState()`
 */
export function wirePlan(host, state) {
	host.systemPrompt.section({
		name: 'cursorPlan:policy',
		order: 502,
		text: (context) => {
			if (context.agent === undefined) return '';
			const session = context.agent.session;
			const selected = selectedMode(host, state, session);
			const text = policyText(selected, modeAtHeaderOf(host, session));
			// The exemption paragraph names `create_ui_block`; a deployment that
			// does not install it gets the tool-free wording instead, so the
			// prompt never points the model at a tool it cannot call.
			if (!text || host.tools.get('create_ui_block', context.agent) !== undefined) return text;
			return text.replace(UI_BLOCK_SENTENCE, UI_BLOCK_SENTENCE_WITHOUT_TOOL);
		}
	});

	host.tools.register(defineTool({
		name: PLAN_TOOL,
		description: CREATE_PLAN_DESCRIPTION,
		parameters: {
			name: {
				type: 'string',
				description: 'A short name for the plan. IMPORTANT: This should only be provided on the FIRST call. On subsequent updates, this field will be ignored to keep the plan file name stable.'
			},
			overview: {
				type: 'string',
				description: 'A 1-2 sentence high-level description of the plan that summarizes what will be accomplished'
			},
			plan: {
				type: 'string',
				required: true,
				description: 'The complete plan, as markdown, starting with a # heading that names it.'
			},
			todos: {
				type: 'array',
				description: 'Optional implementation todos, in execution order.',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: {
							type: 'string',
							required: true,
							description: 'Unique identifier for the todo, e.g. "setup-auth".'
						},
						content: {
							type: 'string',
							required: true,
							description: 'Description of the todo task.'
						},
						status: {
							type: 'string',
							required: true,
							enum: ['pending', 'in_progress', 'completed', 'cancelled'],
							description: 'Current status of the todo.'
						}
					}
				}
			}
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					title: {
						type: 'string',
						required: true
					},
					path: {
						type: 'string',
						required: true
					},
					// The checklist rides back out with the plan: the client card
					// renders it, and the Build bridge writes it into the session as
					// the first `todo/write`. Dropping it here is how the list used
					// to vanish between the model and the card.
					todos: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								id: {
									type: 'string',
									required: true
								},
								content: {
									type: 'string',
									required: true
								},
								status: {
									type: 'string',
									required: true,
									enum: ['pending', 'in_progress', 'completed', 'cancelled']
								}
							}
						}
					}
				}
			},
			render: (args, value) => [{
				type: 'text',
				text: `Plan file: ${value.path}\nPlan "${value.title}" created.`
			}]
		},
		execute: async (args) => {
			const plan = String(args.plan ?? '').trim();
			if (!/^#\s+\S/.test(plan)) {
				throw new Error(`${PLAN_TOOL} requires a non-empty markdown plan starting with a # heading naming it`);
			}
			const { path } = writePlanFile({
				name: args.name,
				overview: args.overview,
				todos: args.todos,
				plan
			});
			return {
				title: firstHeading(plan) ?? 'Plan',
				path,
				todos: Array.isArray(args.todos) ? args.todos : []
			};
		},
		presentCall: (args) => ({
			card: 'generic',
			title: firstHeading(args.plan) ?? 'Plan',
			kind: 'other',
			content: [{ type: 'text', text: String(args.plan ?? '') }]
		})
	}));
}
