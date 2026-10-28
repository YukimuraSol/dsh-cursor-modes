/**
 * The gate's settings seam: register the \`cursor-modes\` namespace through
 * whichever of the three harness generations is running, and report whether the
 * judge credential resolves.
 *
 * Moved from \`dsh-cursor-plan/lib/gate-settings.js:135-169\` (blueprint §5, §1.5
 * tree line "settings.js ← installGateSection 的三代 seam 探测 +
 * credentialView（原 gate-settings.js 后半）"). Both exports keep the retired
 * plugin's exact signatures, because \`index.js\` calls them exactly as the
 * retired \`index.js\` did (:623-650, :675-679):
 *
 *   void installGateSection(ctx, sctx.settings, gate, { setSource, onChange })
 *     .then((api) => sctx.logger?.info?.('… registered via ' + api),
 *           (error) => sctx.logger?.warn?.('… unavailable, using the composed config: %o', error));
 *
 *   credential: () => credentialView(sctx.get('credentials'), liveGate().apiKeyRef)
 *
 * ## Why this is a delegation and not a second copy
 *
 * Blueprint §5 splits the old \`gate-settings.js\` in two: the seam and
 * \`credentialView\` land here, \`gateSchema\` / \`lookupGate\` stay in
 * \`lib/gate-settings.js\`, and the HTTP half goes to \`lib/routes.js\`. That split
 * did not hold in this build: \`lib/gate-settings.js\` arrived as a verbatim copy
 * of the retired file — seam included — and its \`gateSchema\` / \`lookupGate\` are
 * module-private, so the seam cannot be re-implemented here without re-writing
 * both of them.
 *
 * Writing the three-generation probe twice is the one thing that must not
 * happen: it decides *which* API registered the namespace, and a second copy
 * would let two paths register the same namespace and disagree about the answer
 * (and two copies of the \`"cursor-modes" settings namespace is not registered\`
 * reason string that \`self-check-bridge.mjs\` asserts on). So the probe stays in
 * ONE module — \`gate-settings.js\`, where it already is — and this file is the
 * named seam \`index.js\` imports. The logic is not touched: it is the same
 * function object, re-exported under a wrapper so the JSDoc contract lives
 * beside the name \`index.js\` calls.
 *
 * @module dsh-cursor-modes/settings
 */

import { credentialView as credentialViewOf, installGateSection as installGateSectionOf } from './gate-settings.js';

/**
 * The settings namespace the card edits. Re-exported so no second literal exists
 * (blueprint §9 R7: \`cursor-plan\` → \`cursor-modes\`) and so \`index.js\` can name
 * the namespace without importing the HTTP module.
 */
export { GATE_SETTINGS_NS } from './gate-settings.js';

/**
 * Register the gate namespace on top of the composed config, newest seam first.
 *
 * Three harness generations, in this order (unchanged from
 * \`dsh-cursor-plan/lib/gate-settings.js:135-151\`):
 *
 * 1. **0.1.7+** — a namespace *is* a profile entry id and its form is derived
 *    from that entry's Config, so there is nothing to install. The check is that
 *    \`describe()\` already lists it; a missing entry is a real defect (the card's
 *    writes would land nowhere) and is thrown rather than swallowed. Returns
 *    \`'configSchema'\`.
 * 2. **alpha** — \`settings.installSection(owner, ns, schema, base, hooks)\`.
 *    Returns \`'installSection'\`.
 * 3. **rc.2** — the module-level \`installSettingsSection\` with
 *    \`settingsNamespace(ns)\`, imported lazily from
 *    \`@deepseek-ai/dsh-settings\`. Returns \`'installSettingsSection'\`.
 *
 * A settings service with neither \`describe\` nor \`installSection\` is a fourth
 * generation nobody wrote for, and the probe throws
 * \`'dsh-settings exposes no registration API (installSection/installSettingsSection both missing)'\`.
 *
 * Strictly additive: a failure here leaves the plugin on exactly the composed
 * config it already resolved, which is why \`index.js\` mounts it with a warning
 * and never lets it cost the mode itself.
 *
 * @param {object} owner The plugin context the registration belongs to; its
 * unload removes the namespace.
 * @param {object} settings The live \`settings\` service.
 * @param {object} base The composed gate block, used as the composition layer.
 * @param {{ setSource: (source: () => object) => void, onChange: () => void }} hooks
 * \`setSource\` receives the live snapshot getter, \`onChange\` fires after every
 * committed edit. Older seams need both; from 0.1.7 the plugin reads its own
 * Config references, which the Loader updates in place.
 * @returns {Promise<'configSchema' | 'installSection' | 'installSettingsSection'>} Which API registered it.
 * @throws {Error} When no harness generation accepts the namespace, or it
 * refuses it (missing entry, missing volatile fields, duplicate registration).
 */
export async function installGateSection(owner, settings, base, hooks) {
	return installGateSectionOf(owner, settings, base, hooks);
}

/**
 * \`{ ref, configured }\` for the judge credential. \`resolve\` returns the value
 * or \`undefined\`; only the boolean leaves this function, so no bridge response
 * can carry a secret.
 *
 * Unchanged from \`dsh-cursor-plan/lib/gate-settings.js:162-169\`.
 *
 * @param {object | undefined} credentials The live \`credentials\` service, if mounted.
 * @param {string} ref The credential reference the current gate names.
 * @returns {Promise<{ ref: string, configured: boolean }>}
 */
export async function credentialView(credentials, ref) {
	return credentialViewOf(credentials, ref);
}
