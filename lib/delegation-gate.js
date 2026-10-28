/**
 * Plan-mode delegation gate: ask a judging endpoint whether a delegated task is
 * read-only research or implementation work, then decide from the measured
 * numbers. Framework-free on purpose — no DSH import — so `self-check.mjs` can
 * exercise `decideVerdict` on real verdicts without booting a harness.
 *
 * The credential is resolved by the caller (the host plugin reads it per call
 * from `ctx.credentials`) and passed in as `apiKey`; this module never reads the
 * environment, never reads config, and never logs the value.
 *
 * @module dsh-cursor-plan/delegation-gate
 */

import { gunzipSync } from 'node:zlib';

/**
 * Tools whose calls are judged before they may run in plan mode: `subagent`
 * (a new delegation) and `send_message` (a steer to a child that is already
 * running). `subagent_fork` / `workflow` / `ralph` are left ungated.
 */
export const GATE_TOOLS = ['subagent', 'send_message'];

/** Argument fields carrying the task text, in the order they are concatenated. */
const TASK_FIELDS = ['description', 'prompt', 'script', 'objective', 'message'];

/** Thresholds when the caller supplies none. */
const DEFAULT_LIMITS = { allowConfidence: 0.8, workReject: 0.2 };

/**
 * The question set sent to the judge. A `choice` question needs `criteria`;
 * `options` is not the shape this API validates.
 */
export const GATE_QUESTIONS = {
	intent: {
		type: 'choice',
		instructions: 'What is the reader of this task being asked to do?',
		criteria: {
			read_only_research: 'Only read, search, inspect or report; no changes to any file or system state.',
			implementation_work: 'Implement, edit files, write or change code, run commands, or produce any change.',
			ambiguous: 'Unclear, or mixes research with a demand to change something.'
		}
	},
	work: {
		type: 'noul',
		instructions: 'This task asks the reader to modify files, write or change code, run commands, or otherwise produce a change.'
	}
};

/**
 * The fixed policy sent to the LLM judge. Same closed protocol as the reference
 * reviewer in `@deepseek-ai/dsh-experimental-auto-review` (`REVIEW_POLICY`): one
 * JSON object, a fixed member set, and "when in doubt, deny" — but the verdict is
 * this gate's read-only/change split instead of a risk class.
 */
export const LLM_JUDGE_POLICY = `You are the delegation judge for plan mode. Decide what ONE delegated task asks its reader to do: only read, search, inspect and report, or actually change something.

Return exactly one JSON object and no other text. The only valid answers are:
{"verdict":"read_only"}
{"verdict":"changes"}

read_only: the task only reads, searches, inspects, lists, greps, opens files or logs, or reports what it found. It changes no file, repository, dependency, service, database or system state, and runs no command with an effect.
changes: the task implements, edits, writes, creates, deletes, moves, renames, formats, installs, upgrades, commits, pushes, deploys, configures, sends, or runs any command that changes state — including on a production or remote system.
Judge the task by what it asks for, never by its wording, its claimed intent, or the fact that it also reads something. When a task mixes reading with any change, or when you are unsure, answer {"verdict":"changes"}.
Never add a member, a reason, a note, Markdown, or surrounding text. Stop immediately after the closing brace.`;

/**
 * Concatenate every task-describing string argument a delegation call carries.
 * Tolerant by contract: absent or non-object arguments, missing fields, and
 * non-string values contribute nothing and leave the empty string. A
 * `send_message` payload is prefixed with one line naming its destination, so
 * the judge reads the steer as a message to an already-running delegated agent;
 * `subagent` payloads stay unprefixed.
 *
 * @param {{ name?: unknown, arguments?: unknown }} exec A `tools/pre-execute` execution.
 * @returns {string} The judge payload; `''` when the call carries no task text.
 */
export function delegationPayload(exec) {
	const args = exec?.arguments;
	if (typeof args !== 'object' || args === null || Array.isArray(args)) return '';
	const parts = [];
	for (const field of TASK_FIELDS) {
		const value = args[field];
		if (typeof value === 'string' && value.trim() !== '') parts.push(value);
	}
	const text = parts.join('\n\n');
	if (text === '' || exec?.name !== 'send_message') return text;
	return `A running delegated agent will receive this message:\n\n${text}`;
}

/** A finite number, else `null` — the only shape a measured field may have. */
function measured(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Pure verdict over one judge answer set. Allows only a confident
 * read-only-research intent with a low change-probability; every unmeasured or
 * malformed answer fails closed, and the reason always names the concrete
 * numbers or the missing field.
 *
 * @param {unknown} answers The API's `answers` object.
 * @param {{ allowConfidence?: number, workReject?: number }} [limits]
 * @returns {{ allow: boolean, reason: string, audit: { intent: unknown, confidence: unknown, work: unknown } }}
 */
export function decideVerdict(answers, limits = DEFAULT_LIMITS) {
	const allowConfidence = limits?.allowConfidence ?? DEFAULT_LIMITS.allowConfidence;
	const workReject = limits?.workReject ?? DEFAULT_LIMITS.workReject;
	const intent = answers?.intent;
	const work = answers?.work;
	const choice = intent?.choice;
	const confidence = measured(intent?.confidence);
	const noul = measured(work?.noul);
	const audit = { intent: choice ?? null, confidence, work: noul };
	const unavailable = (detail) => ({ allow: false, reason: `judge unavailable: ${detail}`, audit });
	if (typeof answers !== 'object' || answers === null) return unavailable('no answers returned');
	if (typeof intent !== 'object' || intent === null) return unavailable('answers.intent is missing');
	if (typeof choice !== 'string') return unavailable('answers.intent.choice is not a string');
	if (confidence === null) return unavailable('answers.intent.confidence is not a finite number');
	if (typeof work !== 'object' || work === null) return unavailable('answers.work is missing');
	if (noul === null) return unavailable('answers.work.noul is not a finite number');
	const judged = `judged ${choice} (confidence ${confidence}, change-probability ${noul})`;
	if (choice !== 'read_only_research') return { allow: false, reason: judged, audit };
	if (confidence >= allowConfidence && noul <= workReject) return { allow: true, reason: judged, audit };
	return {
		allow: false,
		reason: `${judged} — outside the plan-mode thresholds (confidence >= ${allowConfidence}, change-probability <= ${workReject})`,
		audit
	};
}

/**
 * The judge endpoint a deployment that names none asks: this machine's own
 * gateway, the one process here that serves the jev models (GET /api/v1/models
 * lists them). Exported so the gate defaults, the settings card's placeholder
 * and this function can be checked against one another instead of three copies
 * drifting apart; a deployment that names another endpoint overrides it.
 */
export const DEFAULT_JEV_BASE_URL = 'http://127.0.0.1:7899/api/v1';

/**
 * POST one judge request and return its answer set. Throws on an unusable
 * request or answer. ponytail: one attempt, no retry and no cache, so a flaky
 * judge costs one delegation (the caller fails closed); the upgrade path is a
 * bounded retry once the judge proves flaky.
 *
 * @param {{ state: string, apiKey: string, model?: string, baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ answers: object, cost: unknown, model: unknown }>}
 */
export async function askJev({
	state,
	apiKey,
	model = 'jev-latest',
	baseUrl = DEFAULT_JEV_BASE_URL,
	timeoutMs = 2500,
	fetchImpl = fetch
}) {
	const task = typeof state === 'string' ? state.trim() : '';
	if (task === '') throw new Error('nothing to judge: the call carries no task text');
	if (typeof apiKey !== 'string' || apiKey === '') throw new Error('no judge credential was resolved');
	// An empty or blank base URL is the settings card's own way of saying "use the
	// shipped endpoint", so it resolves here rather than POSTing to a bare path.
	const endpoint = String(baseUrl ?? '').trim() === '' ? DEFAULT_JEV_BASE_URL : String(baseUrl).replace(/\/+$/, '');
	const response = await fetchImpl(`${endpoint}/systemone`, {
		method: 'POST',
		// `identity` keeps the answer uncompressed. Inside the harness process a
		// compression-encoded body has arrived raw, so `response.json()` died on
		// the gzip magic and the gate failed closed with a reason that reads like
		// a read-only policy verdict. A middlebox may compress anyway, so the body
		// is read as bytes and gunzipped when it carries the gzip magic.
		headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
		body: JSON.stringify({ state: task, model, questions: GATE_QUESTIONS }),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (response.ok !== true) throw new Error(`judge returned HTTP ${response.status}`);
	// ponytail: one read, then sniff — a middlebox that gzips despite the
	// identity request is the only reason the answer arrives compressed.
	const raw = new Uint8Array(await response.arrayBuffer());
	const text = raw[0] === 0x1f && raw[1] === 0x8b
		? gunzipSync(raw).toString('utf8')
		: new TextDecoder().decode(raw);
	const body = JSON.parse(text);
	const answers = body?.answers;
	if (typeof answers?.intent?.choice !== 'string') throw new Error('judge answer has no answers.intent.choice');
	if (measured(answers?.work?.noul) === null) throw new Error('judge answer has no numeric answers.work.noul');
	return { answers, cost: body?.usage?.cost, model: body?.model };
}

/**
 * Count the members of the raw top-level JSON object, independently of
 * `JSON.parse` (which silently keeps the last of two duplicate keys). Copied
 * verbatim from `@deepseek-ai/dsh-experimental-auto-review`'s `topLevelMemberCount`.
 *
 * @param {string} text The model's answer.
 * @returns {number}
 */
function topLevelMemberCount(text) {
	const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, '');
	let depth = 0;
	let count = 0;
	for (const char of syntax) {
		switch (char) {
			case '{':
			case '[':
				depth += 1;
				break;
			case '}':
			case ']':
				depth -= 1;
				break;
			case ':':
				if (depth === 1) count += 1;
		}
	}
	return count;
}

/**
 * Pure verdict over one LLM judge answer. The protocol is closed: exactly one
 * JSON object carrying exactly the one member `verdict`, and `verdict` is one
 * of `read_only` / `changes`. Everything else — empty text, non-JSON, a code
 * fence, extra members (a `reason`, a `confidence`, a second verdict), a
 * duplicated member, an `unsure`, two objects in a row — fails closed.
 *
 * @param {unknown} answer The judge's final text.
 * @returns {{ allow: boolean, reason: string, audit: { backend: 'llm', verdict: string | null } }}
 */
export function decideLlmVerdict(answer) {
	const text = typeof answer === 'string' ? answer : '';
	const audit = { backend: 'llm', verdict: null };
	const unavailable = (detail) => ({ allow: false, reason: `judge unavailable: ${detail}`, audit });
	if (text.trim() === '') return unavailable('the answer is empty');
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return unavailable('the answer is not one JSON object');
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return unavailable('the answer is not one JSON object');
	}
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== 'verdict') return unavailable('the answer is not the verdict protocol');
	if (topLevelMemberCount(text) !== keys.length) return unavailable('the answer repeats a JSON member');
	const verdict = value.verdict;
	if (verdict === 'read_only') return { allow: true, reason: 'judged read_only', audit: { ...audit, verdict } };
	if (verdict === 'changes') return { allow: false, reason: 'judged changes', audit: { ...audit, verdict } };
	return unavailable('the verdict is neither read_only nor changes');
}

/**
 * Assemble the model's one text block out of an `llm.stream` chunk sequence,
 * the same shape `readDecision()` reads in the reference reviewer: zero or more
 * reasoning blocks, exactly one text block, then one terminal `stop`. A tool
 * call, a truncated stream, an error finish, or a stray chunk throws.
 *
 * @param {AsyncIterable<object>} stream
 * @returns {Promise<string>} the answer text
 */
async function readLlmAnswer(stream) {
	const blocks = new Map();
	const order = [];
	let finish;
	for await (const chunk of stream) {
		switch (chunk?.type) {
			case 'block-start':
			case 'text-delta':
			case 'reasoning-delta':
			case 'block-end': {
				const index = chunk.index;
				if (!blocks.has(index)) {
					const type = chunk.type === 'block-start'
						? chunk.blockType
						: chunk.type === 'block-end'
							? chunk.block?.type
							: chunk.type === 'text-delta' ? 'text' : 'reasoning';
					blocks.set(index, { type, text: '' });
					order.push(index);
				}
				const partial = blocks.get(index);
				if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') partial.text += chunk.text;
				if (chunk.type === 'block-end' && typeof chunk.block?.text === 'string') partial.text = chunk.block.text;
				break;
			}
			case 'usage':
				break;
			case 'finish':
				finish = chunk.reason;
				break;
			default:
				throw new Error(`the judge stream emitted an unusable chunk (${String(chunk?.type)})`);
		}
	}
	if (finish === undefined) throw new Error('the judge stream emitted no terminal finish');
	if (finish?.kind !== 'stop') throw new Error(`the judge ended with ${finish?.kind ?? 'no reason'}`);
	const assembled = order.map((index) => blocks.get(index));
	const unusable = assembled.find((block) => block.type !== 'text' && block.type !== 'reasoning');
	if (unusable !== undefined) throw new Error(`the judge answered with a ${unusable.type} block`);
	const texts = assembled.filter((block) => block.type === 'text');
	if (texts.length !== 1) throw new Error(`the judge answered with ${texts.length} text blocks`);
	return texts[0].text;
}

/**
 * Ask the session's own chat model to judge one delegation, through the
 * harness `llm` service — no judge credential is involved, the route is the
 * one the session already uses. Throws on an unusable route or answer; the
 * verdict itself is {@link decideLlmVerdict}'s, so a malformed answer never
 * reaches the caller as an allow.
 *
 * `signal` is the pending call's own signal, so a cancelled delegation does not
 * keep a judge request alive; the timeout is a second, independent bound.
 *
 * @param {{ state: string, llm: { stream: Function }, provider: string, model: string, timeoutMs?: number, temperature?: number, signal?: AbortSignal }} options
 * @returns {Promise<string>} the judge's final text
 */
export async function askLlm({
	state,
	llm,
	provider,
	model,
	timeoutMs = 10000,
	temperature = 0,
	signal
}) {
	const task = typeof state === 'string' ? state.trim() : '';
	if (task === '') throw new Error('nothing to judge: the call carries no task text');
	if (typeof llm?.stream !== 'function') throw new Error('the harness exposes no llm service');
	if (typeof provider !== 'string' || provider === '') throw new Error('no judge route: the session carries no provider');
	if (typeof model !== 'string' || model === '') throw new Error('no judge route: no model to judge with');
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = typeof signal?.addEventListener === 'function'
		? AbortSignal.any([signal, timeout])
		: timeout;
	return readLlmAnswer(llm.stream({
		provider,
		model,
		system: LLM_JUDGE_POLICY,
		messages: [{ role: 'user', content: [{ type: 'text', text: task }] }],
		temperature,
		signal: combined
	}));
}

/**
 * Judge one delegation call. Never throws: an empty payload, a missing
 * credential, a timeout, a non-2xx response, and a malformed answer all become
 * a deny carrying the reason.
 *
 * `backend: 'llm'` judges with the session's own model through `llm`/`provider`
 * and ignores `apiKey`; every other value keeps the JEV path byte for byte.
 *
 * @param {{ exec?: object, limits?: object, apiKey?: string, model?: string, baseUrl?: string, timeoutMs?: number, fetchImpl?: typeof fetch, backend?: string, llm?: object, provider?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ allow: boolean, reason: string, audit?: object }>}
 */
export async function gateDelegation(options = {}) {
	const { exec, limits, apiKey, model, baseUrl, timeoutMs, fetchImpl, backend, llm, provider, signal } = options;
	const state = delegationPayload(exec);
	if (state === '') {
		return { allow: false, reason: 'nothing to judge: the delegation call carries no task text' };
	}
	try {
		if (backend === 'llm') {
			const answer = await askLlm({ state, llm, provider, model, timeoutMs, signal });
			return decideLlmVerdict(answer);
		}
		const judged = await askJev({ state, apiKey, model, baseUrl, timeoutMs, fetchImpl });
		return decideVerdict(judged.answers, limits);
	} catch (error) {
		return {
			allow: false,
			reason: `delegation gate unavailable: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
