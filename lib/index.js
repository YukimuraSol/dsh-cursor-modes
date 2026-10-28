/**
 * The one `apply()`: four `ctx.inject` groups, one `agent/pre-step`, one
 * `tools/pre-execute`, one `tools/post-execute`. No mode command registers
 * anywhere: the mode control's bridge stages a selection and `agent/pre-step`
 * commits it when the step delivers the user's own message (口径 S1). No
 * business logic lives here (blueprint §1.5 boundary discipline 1) — every hook
 * body is a named function exported by `state/plan/multi/switch`.
 *
 * ## Registration surface (blueprint §4.2)
 *
 *   projection `mode` (stateVersion 4)   → projection.js, registered here
 *   section `mode:policy` order 501      → wireMulti
 *   section `cursorPlan:policy` order 502 → wirePlan
 *   tool `create_plan`                   → wirePlan
 *   tool `request_more_edits`            → wireMulti
 *   `agent/inbox/claimed`                → wireMulti
 *   `agent/pre-step`                     → here (1, was 2)
 *   `tools/pre-execute`                  → here (1, was 2)
 *   `tools/post-execute`                 → here (1, was 2)
 *   8 HTTP routes                        → build.js + routes.js + gate-settings.js
 *   1 settings seam                      → settings.js
 *
 * ## Why the HTTP routes are split across two inject groups
 *
 * `routes.js` can build all eight at once (`makeRoutes`), but the two families
 * have different service needs: build + switch need `agents`, the settings
 * family needs `settings`. Merging them into one group would make a host
 * without a `settings` service lose the build and switch routes too — the old
 * tree registered them independently and so does this one. `makeRoutes` stays
 * as the reference table that `self-check-runtime.mjs` compares the two live
 * groups against, so the split cannot silently drift.
 *
 * ## Why the single pre-execute runs the plan gate first (blueprint §5.2)
 *
 * A write refused by plan mode must not be billed against the multi quota: the
 * first error the user sees has to name the mode, not an exhausted budget, and
 * `decideEdit` charges and queues a notice at the boundary.
 *
 * ## Why the post-execute settles before it notifies
 *
 * A `run_code`'s charge is deferred to its post-execute (`settleRoot`): free
 * when every dispatch was a delegation tool, one unit otherwise, and one unit
 * for a pure computation that dispatched nothing. `settleExec` therefore runs
 * first, so a settle that spends the last unit still finds its notice latched
 * when `attachQuotaNotice` looks.
 *
 * The two legacy handlers already behaved this way for plan mode (`dsh-modes`
 * never settled a plan-mode call), so the ordering is the status quo made
 * explicit.
 *
 * **If these two gates are ever split back into separate handlers, the plan gate
 * must be registered with `ctx.on('tools/pre-execute', fn, { prepend: true })`**
 * (cordis `lib/index.js:371-380`: `prepend` → `unshift`). Plain `ctx.on` pushes,
 * and a waterfall runs the outermost first — the split would reintroduce
 * "ordering by registration", which is exactly what the merge removed.
 *
 * @module dsh-cursor-modes
 */

import schemastery from '@deepseek-ai/schemastery';
import { makeBuildRoutes } from './build.js';
import { GATE_DEFAULTS, PLAN_MODE_ID, judgeBackend, resolveConfig } from './cursor-plan.js';
import { makeGateRoutes } from './gate-settings.js';
import { MULTI_ID } from './multi-prompt.js';
import {
	appendPlanDoc,
	commitPlanMode,
	delegationBlock,
	planModeBlock,
	wirePlan
} from './plan.js';
import {
	attachQuotaNotice,
	commitMultiMode,
	editGate,
	gateOf,
	settleExec,
	wireMulti
} from './multi.js';
import {
	modeProjectionDefinition,
	registerModeEventTypes
} from './projection.js';
import { makeSwitchRoutes } from './routes.js';
import { credentialView, installGateSection } from './settings.js';
import { commitBuildTodos, createState, selectedMode } from './state.js';

/**
 * Whether a Config value is one of the Loader's live volatile references rather
 * than plain data. The same `Symbol.for` key cosmokit writes, so the test holds
 * across the ESM/CJS copies a linked plugin ends up with.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const isVolatile = (value) => typeof value === 'object' && value !== null && VOLATILE_WRITE in value;

/**
 * Deployment config. `defaultSection` is the reserved placeholder the tree has
 * always accepted; the `gate` block is the delegation gate's deployment default
 * and, because it is `.volatile()`, also what makes the settings card work: a
 * settings namespace *is* a profile entry id, and a card edit is committed into
 * the running plugin's reference instead of remounting it.
 *
 * The bounds mirror `validateGatePatch` in `cursor-plan.js`, which still guards
 * the deployment config at load and every card write.
 */
export const Config = schemastery.object({
	defaultSection: schemastery.string().default(''),
	gate: schemastery.object({
		enabled: schemastery.boolean().default(GATE_DEFAULTS.enabled),
		// Which judge answers a delegation: the JEV decision model, or the
		// session's own chat model (no credential needed).
		backend: schemastery.string().default(GATE_DEFAULTS.backend),
		// The judge's model; empty follows the backend's own default route.
		model: schemastery.string().default(GATE_DEFAULTS.model),
		baseUrl: schemastery.string().default(GATE_DEFAULTS.baseUrl),
		timeoutMs: schemastery.number().step(1).min(1).default(GATE_DEFAULTS.timeoutMs),
		allowConfidence: schemastery.number().min(0).max(1).default(GATE_DEFAULTS.allowConfidence),
		workReject: schemastery.number().min(0).max(1).default(GATE_DEFAULTS.workReject),
		// The legacy credential reference, and the JEV judge's own key stored as the
		// plain string the card's connection row types in. The key is the field the
		// card writes; the reference only resolves while the key is empty.
		apiKeyRef: schemastery.string().default(GATE_DEFAULTS.apiKeyRef),
		apiKey: schemastery.string().default(GATE_DEFAULTS.apiKey)
	}).default({ ...GATE_DEFAULTS }).volatile()
});

// The Loader unwraps this module's `export default` to the bare `apply` function
// and then reads `plugin.Config`, so the schema has to ride on the function
// itself. Without this line the entry exposes no Config, the settings namespace
// does not exist, and the card shows its "not registered" line.
apply.Config = Config;

/**
 * dsh-cursor-modes: the merged successor of `dsh-cursor-plan`, `dsh-modes` and
 * `dsh-mode-switch`. Owns the two policy sections, the `mode` session
 * projection, `create_plan`, `request_more_edits`, the plan-mode edit gate, the
 * multitask quota gate and the eight HTTP routes. The mode is switched from the
 * composer's mode control only — no mode command exists.
 *
 * @param ctx - host-plane context carrying the four service groups below.
 * @param config - deployment config; only the reserved `defaultSection` and the
 *   optional `gate` block are accepted. `gate` arrives as a volatile reference
 *   from 0.1.7 on: unwrapped once for the load-time check, read live per judged
 *   call.
 */
export async function apply(ctx, config = {}) {
	// Must run before any session is observed: a v4 log whose `cursorPlan/state`
	// is not in the host's whitelist throws out of `restoreReleasedV4Artifact`,
	// i.e. an old session simply fails to open. Synchronous by construction
	// (createRequire), so no top-level await sits in the plugin body.
	registerModeEventTypes(process.argv);
	// 0.1.7+ hands out every `.volatile()` Config field as a live reference. The
	// snapshot is unwrapped once so the load-time validation below still sees
	// plain data; the reference itself is kept for the per-call reads.
	const gateRef = config?.gate;
	const rawGate = isVolatile(gateRef) ? gateRef.get() : gateRef;
	// An unknown judge backend must not cost the plugin load: the gate keeps
	// working on `jev` and the value is named once, here, where a logger exists.
	if (typeof rawGate === 'object' && rawGate !== null && Object.hasOwn(rawGate, 'backend')
		&& judgeBackend(rawGate.backend) !== rawGate.backend) {
		console.warn('dsh-cursor-modes: unknown gate.backend %o, falling back to jev', rawGate.backend);
	}
	const config0 = resolveConfig({ ...config, gate: rawGate });
	/** Reserved for a future default-section payload; empty today. */
	void config0.defaultSection;
	/** Delegation-gate config; a deployment that sets no `gate` gets the off defaults. */
	const gate = { ...GATE_DEFAULTS, ...config0.gate };
	/** The single state bag: mode latches, pending map, quota store, notice ids. */
	const state = createState();
	/** Most recent judge outcome, in memory only: the settings card's status line reads it. */
	const verdicts = { last: null };
	/**
	 * Effective gate values, read per judged call: from the live Config reference
	 * when the harness delivers one (0.1.7+, so a settings-card edit reaches the
	 * next delegation with no reload), else the value resolved at load. The
	 * settings seam below overrides this with its own snapshot on older hosts.
	 */
	let liveGate = () => (isVolatile(gateRef) ? { ...GATE_DEFAULTS, ...gateRef.get() } : gate);

	// Function plugins cannot read services on the outer ctx, so the services are
	// declared here. ponytail: one inject list, not a Service.
	// 'llm' is here for the LLM judge backend: it asks the session's own model
	// through the host's `llm` service and needs no credential of its own.
	ctx.inject(['llm', 'systemPrompt', 'sessionProjections', 'tools'], (host) => {
		// The projection first: `loggedMode` throws on its first read when it is
		// not mounted, so a mis-ordered mount fails loudly instead of reading
		// `undefined` as a mode.
		host.sessionProjections.register(modeProjectionDefinition);

		wireMulti(host, state);
		wirePlan(host, state);

		// One pre-step. Commit first, settle second (inside commitMultiMode): the
		// mode a command queued is in the log by the time the quota is measured, so
		// the window is charged against the mode the step actually runs in.
		//
		// The default Build's checklist rides the same hook, last: the click only
		// stages it (the session is idle then, and `turn/start` would wipe an
		// append), so this is the first moment after that turn opened. Same window,
		// and the same reason, as the kernel's own `attachInitialTodos`.
		host.on('agent/pre-step', async ({ agent, signal }, next) => {
			const decision = await next();
			const planned = commitPlanMode(host, state, agent, signal, decision);
			const settled = commitMultiMode(host, state, agent, signal, planned);
			return commitBuildTodos(host, state, agent, settled);
		});

		// One pre-execute: plan gate first, multi quota second (see the module docblock).
		host.on('tools/pre-execute', async (exec, next) => {
			if (exec.agent === undefined) return next();
			const session = exec.agent.session;
			// The only judgement source: pending overrides committed, so a queued
			// switch gates (and stops gating) on time.
			const mode = selectedMode(host, state, session);

			// Gate 1 — plan mode. The delegation judge runs ahead of the markdown
			// gate, the same order `dsh-cursor-plan` used internally.
			if (mode === PLAN_MODE_ID) {
				const delegated = await delegationBlock(host, exec, () => liveGate(), verdicts);
				if (delegated !== undefined) return { kind: 'deny', reason: delegated };
				const reason = planModeBlock(exec);
				if (reason !== undefined) return { kind: 'deny', reason };
				return next();
			}

			// Gate 2 — multitask quota. `editGate` settles the stretch and returns
			// gate.js's own verdict: null | allow | notify | deny. A `run_code` is
			// allowed here and priced at its post-execute, so a spent stretch can
			// still delegate.
			if (mode !== MULTI_ID) return next();
			const verdict = editGate(exec, gateOf(exec.agent));
			if (verdict === null || verdict.kind === 'allow') return next();
			if (verdict.kind === 'deny') return { kind: 'deny', reason: verdict.reason };
			// `notify`: the quota just ran out, so the call runs and the notice
			// rides its result in post-execute.
			return next();
		});

		// One post-execute. `attachQuotaNotice` returns a NEW decision
		// (`additionalContexts` is the only channel the model sees), so it must run
		// first and its return value must be handed on; the plan-doc append is a
		// plain side effect and cannot drop it.
		host.on('tools/post-execute', async (exec, result, next) => {
			let decision = await next();
			if (exec.agent === undefined) return decision;
			// The deferred `run_code` charge is priced first, so its last-unit
			// notice is latched before `attachQuotaNotice` looks for it.
			settleExec(exec);
			decision = attachQuotaNotice(exec, decision);
			appendPlanDoc(host, exec, result, state);
			return decision;
		});
	});

	// The settings page's live half, mounted after the mode wiring so a failure
	// here can never cost the modes themselves. Strictly additive: no settings
	// service, no Config schema the harness can project, or a rejected namespace
	// leaves the plugin on the composed config it resolved above, with one warning.
	ctx.inject(['settings'], (sctx) => {
		// `ctx` (not `sctx`) is the owner: the namespace belongs to this plugin's
		// own fiber, so unloading the plugin removes it.
		void installGateSection(ctx, sctx.settings, gate, {
			// Older harnesses only: their settings section hands back a snapshot
			// getter that `settings` re-resolves on every commit. From 0.1.7 the
			// live reference read above is already current, so this never fires.
			setSource: (source) => {
				liveGate = () => {
					try {
						return { ...gate, ...(source() ?? {}) };
					} catch {
						return gate;
					}
				};
			},
			// Nothing to invalidate — `liveGate` reads the snapshot per call — so the
			// change is logged for the harness log's sake alone.
			onChange: () => {
				sctx.logger?.info?.('dsh-cursor-modes: gate settings updated');
			}
		}).then(
			(api) => sctx.logger?.info?.(`dsh-cursor-modes: gate settings registered via ${api}`),
			(error) => sctx.logger?.warn?.('dsh-cursor-modes: gate settings unavailable, using the composed config: %o', error)
		);
	});

	// Five of the eight routes: the Build buttons' bridge, the two switch bridges,
	// the loopback self-test and the vocabulary diagnostics.
	ctx.inject(['webServer', 'agents'], (sctx) => {
		try {
			sctx.effect(() => {
				const disposers = [
					...makeBuildRoutes(sctx.agents, state),
					...makeSwitchRoutes(sctx, state)
				].map((route) => sctx.webServer.register(route));
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, 'dsh-cursor-modes: build + switch bridges');
		} catch (error) {
			sctx.logger?.warn?.('dsh-cursor-modes: build/switch bridges not registered: %o', error);
		}
	});

	// The other three: the card's bridge. It reads the same live values the judge
	// does, so the card and the gate can never disagree about what is in effect.
	ctx.inject(['webServer', 'settings'], (sctx) => {
		try {
			sctx.effect(() => {
				const disposers = makeGateRoutes(sctx.settings, {
					gate: () => liveGate(),
					verdicts,
					credential: () => credentialView(sctx.get('credentials'), liveGate().apiKeyRef)
				}).map((route) => sctx.webServer.register(route));
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, 'dsh-cursor-modes: settings bridge');
		} catch (error) {
			sctx.logger?.warn?.('dsh-cursor-modes: settings bridge not registered: %o', error);
		}
	});
}

export default apply;
export { modeProjectionDefinition };
