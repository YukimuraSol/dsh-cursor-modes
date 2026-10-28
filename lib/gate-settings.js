import { GATE_DEFAULTS, validateGatePatch } from './cursor-plan.js';

/**
 * The delegation gate's live settings surface: the `cursor-plan` settings
 * namespace and the loopback bridge the settings card reads and writes through.
 *
 * Two seams, one per cordis service, and both are strictly additive: the
 * namespace is registered on top of the composed config (a user edit is an
 * override in the settings document and never rewrites `cordis.patch.yml`), and
 * the bridge answers the card. Nothing here may break plan mode — the caller
 * mounts both under a try/catch, a failed registration leaves the plugin on the
 * composed config, and every route answers a JSON object instead of throwing.
 *
 * Three harness generations are registered with, newest first. From 0.1.7 the
 * settings service stopped registering anything: a namespace *is* a profile
 * entry id and its form is derived from that entry's Config, so the gate's
 * fields are declared `.volatile()` and there is no install call left. The
 * older seams still exist for a fallback harness — alpha's
 * `settings.installSection`, then rc.2's module-level
 * `installSettingsSection` with `settingsNamespace(ns)`.
 *
 * Those two older seams (and the Config schema above, which needs
 * `.volatile()`) depend on packages resolved from *this* directory, and the
 * profile links this package by path:
 *
 * - `node_modules/@deepseek-ai/dsh-settings` is a **local junction** into
 *   `<harness home>/profiles/node_modules/@deepseek-ai/dsh-settings`;
 * - `node_modules/@deepseek-ai/schemastery` is a **local junction** into the
 *   same profile location, because the copy this package was installed with
 *   (3.18.2) predates `.volatile()`; it was parked at
 *   `.bak-schemastery-3.18.2-<date>/` in the package root.
 *
 * Both are links, not copies: the harness's own versions, a fresh
 * `npm install` in this directory can prune or replace them, and then this
 * file has to resolve nothing but the newest seam again — rebuild both
 * junctions after any install here.
 *
 * @module dsh-cursor-plan/gate-settings
 */

/** Settings namespace the card edits; the plugins tab dispatches one card per served namespace. */
export const GATE_SETTINGS_NS = 'cursor-modes';

/** Loopback bridge the settings card talks to. */
export const GATE_BRIDGE_PREFIX = '/api/dsh-cursor-modes/settings';

/** One bridge body cap; a settings patch is a handful of scalars. */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * The namespace's schemastery schema, or a pass-through schema when the library
 * is not importable from this package (it arrives transitively today). The
 * caller has already loaded the composed config, and the bridge validates every
 * patch, so the schema is a second line of defence — never the only one.
 *
 * @returns {Promise<Function>} A callable schema carrying `toJSON`, the two
 * methods the settings provider uses.
 */
async function gateSchema() {
	try {
		const { default: z } = await import('@deepseek-ai/schemastery');
		return z.object({
			enabled: z.boolean().default(GATE_DEFAULTS.enabled),
			model: z.string().default(GATE_DEFAULTS.model),
			baseUrl: z.string().default(GATE_DEFAULTS.baseUrl),
			timeoutMs: z.number().default(GATE_DEFAULTS.timeoutMs),
			allowConfidence: z.number().default(GATE_DEFAULTS.allowConfidence),
			workReject: z.number().default(GATE_DEFAULTS.workReject),
			apiKeyRef: z.string().default(GATE_DEFAULTS.apiKeyRef),
			apiKey: z.string().default(GATE_DEFAULTS.apiKey)
		});
	} catch {
		// ponytail: without schemastery the namespace still registers and the
		// bridge validator stays the real gate. The upgrade path is a direct
		// dependency on the schema library once this plugin owns one.
		const passthrough = (value) => value;
		passthrough.toJSON = () => ({});
		return passthrough;
	}
}

/**
 * The `cursor-plan` descriptor the live settings service serves right now, or
 * the reason it is absent. One lookup, shared by the registration check below
 * and the bridge's red line, so the two can never disagree about the cause.
 *
 * @param {object | undefined} settings The live `settings` service.
 * @returns {{ entry: object } | { entry: undefined, reason: string }}
 */
function lookupGate(settings) {
	if (settings === undefined || typeof settings.describe !== 'function') {
		return { entry: undefined, reason: 'the settings service is not mounted in this harness build' };
	}
	let descriptors;
	try {
		descriptors = settings.describe({ redactSecrets: true });
	} catch (error) {
		// A describe() that throws is not a missing namespace: reporting it as one
		// would hide the real failure behind the generic red line.
		const detail = error instanceof Error ? error.message : String(error);
		return { entry: undefined, reason: `settings.describe() failed: ${detail}` };
	}
	const entry = descriptors.find((candidate) => String(candidate.ns) === GATE_SETTINGS_NS);
	if (entry === undefined) {
		return {
			entry: undefined,
			reason: `the "${GATE_SETTINGS_NS}" settings namespace is not registered (no running profile entry with that id, or its Config declares no \`.volatile()\` fields)`
		};
	}
	return { entry };
}

/**
 * Register the `cursor-plan` namespace so the card's edits persist as a user
 * override on top of `base` (the composed gate block).
 *
 * From 0.1.7 there is nothing to install: the namespace is the inserted profile
 * entry (`id: cursor-plan`) and `settings.describe()` lists it as soon as the
 * plugin's Config marks the editable fields `.volatile()`. A missing entry is
 * therefore a real defect — the plugin would fall back to the composed config
 * while the card's writes silently landed nowhere — so it is thrown rather than
 * swallowed. Older harnesses keep their own seam.
 *
 * @param {object} owner The plugin context the registration belongs to; its
 * unload removes the namespace.
 * @param {object} settings The live `settings` service.
 * @param {object} base The composed gate block, used as the composition layer.
 * @param {{ setSource: (source: () => object) => void, onChange: () => void }} hooks
 * `setSource` receives the live snapshot getter; `onChange` fires after every
 * committed edit. Older seams need both; from 0.1.7 the plugin reads its own
 * Config references, which the Loader updates in place.
 * @returns {Promise<'configSchema' | 'installSection' | 'installSettingsSection'>} Which API registered it.
 * @throws {Error} When no harness generation accepts the namespace, or it
 * refuses it (missing entry, missing volatile fields, duplicate registration).
 */
export async function installGateSection(owner, settings, base, hooks) {
	if (typeof settings?.describe === 'function' && typeof settings?.installSection !== 'function') {
		const found = lookupGate(settings);
		if (found.entry === undefined) throw new Error(found.reason);
		return 'configSchema';
	}
	if (typeof settings?.installSection === 'function') {
		settings.installSection(owner, GATE_SETTINGS_NS, await gateSchema(), base, hooks);
		return 'installSection';
	}
	const legacy = await import('@deepseek-ai/dsh-settings');
	if (typeof legacy.installSettingsSection !== 'function' || typeof legacy.settingsNamespace !== 'function') {
		throw new Error('dsh-settings exposes no registration API (installSection/installSettingsSection both missing)');
	}
	legacy.installSettingsSection(owner, legacy.settingsNamespace(GATE_SETTINGS_NS), await gateSchema(), base, hooks);
	return 'installSettingsSection';
}

/**
 * The gate values a card may see: every stored field except the key itself, plus
 * the one boolean the key's row needs. `values` and `defaults` both go through
 * here, so a stored key can never ride a bridge answer — the card rewrites its
 * box from empty every time and reads the boolean instead.
 *
 * @param {object} gate The effective gate values.
 * @returns {{ values: object, apiKeyConfigured: boolean }}
 */
export function publicGate(gate) {
	const { apiKey, ...values } = typeof gate === 'object' && gate !== null ? gate : {};
	return { values, apiKeyConfigured: typeof apiKey === 'string' && apiKey.trim() !== '' };
}

/**
 * `{ ref, configured }` for the judge credential. `resolve` returns the value
 * or `undefined`; only the boolean leaves this function, so no bridge response
 * can carry a secret.
 *
 * @param {object | undefined} credentials The live `credentials` service, if mounted.
 * @param {string} ref The credential reference the current gate names.
 * @returns {Promise<{ ref: string, configured: boolean }>}
 */
export async function credentialView(credentials, ref) {
	try {
		const resolved = await credentials?.resolve(ref);
		return { ref, configured: typeof resolved?.value === 'string' && resolved.value !== '' };
	} catch {
		return { ref, configured: false };
	}
}

/**
 * True for a request sent by this machine's own page. Copied from
 * `dsh-free-search`, which keeps the loopback bridge unreachable from another
 * origin even though the harness itself binds loopback only.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
	const host = request.headers.host;
	if (typeof host !== 'string') return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
	if (request.headers['sec-fetch-site'] === 'cross-site') return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/** One JSON response; a refusal is a body with a `code`, never a transport error. */
function writeJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
	res.end(JSON.stringify(body));
}

/** The parsed request body, or `undefined` for a malformed or oversized one. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_JSON_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		return undefined;
	}
}

/**
 * Build the bridge's route descriptors — three exact POST paths, all
 * loopback-only.
 *
 * @param {object | undefined} settings The live `settings` service.
 * @param {{ gate: () => object, verdicts: { last: object | null }, credential: () => Promise<{ ref: string, configured: boolean }> }} hooks
 * `gate` reads the effective values (the settings scope's snapshot, else the
 * composed config), `verdicts.last` is the in-memory last judge outcome, and
 * `credential` reports whether the named reference resolves.
 * @returns {Array<{ kind: string, path: string, handler: Function }>}
 */
export function makeGateRoutes(settings, hooks) {
	/** One refusal shape, carrying the reason the namespace is not servable. */
	const unavailable = (reason) => ({ ok: false, code: 'settings-unavailable', message: reason });
	const handlers = {
		async describe() {
			const found = lookupGate(settings);
			if (found.entry === undefined) return unavailable(found.reason);
			// The key never rides a bridge answer: `values` carries every other gate field
			// and one boolean says whether a key is stored, so the card can write a
			// placeholder without ever holding the secret.
			const publicValues = publicGate(hooks.gate());
			return {
				ok: true,
				value: {
					ns: GATE_SETTINGS_NS,
					values: publicValues.values,
					defaults: publicGate(GATE_DEFAULTS).values,
					apiKeyConfigured: publicValues.apiKeyConfigured,
					credential: await hooks.credential()
				}
			};
		},
		async mutate(request) {
			const found = lookupGate(settings);
			if (found.entry === undefined) return unavailable(found.reason);
			if (typeof request !== 'object' || request === null || Array.isArray(request)) {
				return { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request (patch is required)' };
			}
			const checked = validateGatePatch(request.patch);
			if (!checked.ok) return { ok: false, code: 'settings-rejected', message: `gate ${checked.message}` };
			try {
				// Merge, never replace: the write lands as an override in the user's
				// settings document and the patch layer keeps its own values.
				//
				// The card speaks one flat gate patch (a field name and a value).
				// From 0.1.7 the namespace is the profile entry, so the form the
				// service writes through is the plugin's own Config shape and the
				// patch has to be nested under `gate`; an older harness installs the
				// gate schema itself as the section and takes the patch as sent.
				const body = typeof settings.installSection === 'function' ? checked.value : { gate: checked.value };
				if (Object.keys(checked.value).length > 0) await settings.update(GATE_SETTINGS_NS, body);
			} catch (error) {
				return { ok: false, code: 'settings-rejected', message: error instanceof Error ? error.message : String(error) };
			}
			// The key's own boolean rides the answer: pasting a key has to flip the box's
			// placeholder on the spot, without a second round trip — and the key itself is
			// dropped from the answered values, so the box is empty again once the write
			// lands. The credential view still answers for the legacy reference.
			const publicValues = publicGate(hooks.gate());
			return {
				ok: true,
				value: publicValues.values,
				apiKeyConfigured: publicValues.apiKeyConfigured,
				credential: await hooks.credential()
			};
		},
		async status() {
			const gate = hooks.gate();
			return {
				ok: true,
				value: {
					enabled: gate.enabled,
					credential: await hooks.credential(),
					effectiveTimeoutMs: gate.timeoutMs,
					allowConfidence: gate.allowConfidence,
					workReject: gate.workReject,
					lastVerdict: hooks.verdicts.last,
					apiKeyConfigured: publicGate(gate).apiKeyConfigured
				}
			};
		}
	};
	const guard = (req, res) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: 'loopback requests only' });
			return false;
		}
		if (req.method !== 'POST') {
			writeJson(res, 405, { error: `method not allowed: ${req.method ?? ''}` });
			return false;
		}
		return true;
	};
	const reply = (name) => async (req, res) => {
		if (!guard(req, res)) return;
		writeJson(res, 200, await handlers[name]({}));
	};
	const accept = (name) => async (req, res) => {
		if (!guard(req, res)) return;
		const body = await readJsonBody(req);
		if (body === undefined) {
			writeJson(res, 400, { ok: false, code: 'settings-rejected', message: 'malformed JSON body' });
			return;
		}
		writeJson(res, 200, await handlers[name](body));
	};
	return [
		{ kind: 'exact', path: `${GATE_BRIDGE_PREFIX}/describe`, handler: reply('describe') },
		{ kind: 'exact', path: `${GATE_BRIDGE_PREFIX}/mutate`, handler: accept('mutate') },
		{ kind: 'exact', path: `${GATE_BRIDGE_PREFIX}/status`, handler: reply('status') }
	];
}
