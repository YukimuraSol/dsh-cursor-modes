/**
 * The three shipped agent presets, derived at load instead of restated here.
 *
 * Why a derivation exists: a profile patch cannot reach inside a preset's
 * `config.plugins`. A patch entry replaces that config wholesale, so the only
 * declarative way to change one row of a shipped preset is to copy the whole
 * list into the profile - and that copy then pins the preset to the version it
 * was taken from, silently overriding every later upstream change to it. This
 * profile carried ~400 lines of such restatements; they are three
 * `disabled: true` stubs now, and the rows come from the shipped file again.
 *
 * What it changes: one row, `plan-mode`, given `disabled: true`. Nothing else.
 * The rest of the list is the shipped file's, untouched, including its
 * `!!js` scalars - those are parsed by `entryListSchema` from
 * `@deepseek-ai/cordis-plugin-include` into the `{ __jsExpr }` objects the
 * Loader evaluates at each mount decision, so a row reaches the registry in
 * exactly the shape the file wrote it.
 *
 * Why the row and not the tool: `@deepseek-ai/dsh-plan-mode` is one package
 * supplying six things - the `exit_plan_mode` tool, the `/plan` command, the
 * `plan:policy` prompt section, the `plan` session projection, an
 * `agent/pre-step` hook and the `planMode` service. Withholding the tool at
 * runtime leaves the other five, which is a session that can enter plan mode
 * and never leave it. The row not loading is the only lever that removes all
 * six, and a row lives in a preset.
 *
 * Every preset here is required, not best-effort: the profile disables the
 * shipped rows so this module can claim their ids, which means a miss does not
 * fall back to anything - it leaves the instance with no preset to create a
 * session from. So a missing file, a missing declaration, a missing `plan-mode`
 * row and a failed write all throw, and the throw fails the plugin's load.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Shipped preset directory inside `@deepseek-ai/dsh-web-app`. */
const PRESET_DIR = '@deepseek-ai/dsh-web-app/presets'

/**
 * The presets derived here, in registration order.
 *
 * `minimal` is deliberately absent: it ships no plan mode, so deriving it would
 * buy nothing and would claim a fourth id the profile has not freed.
 */
export const PRESETS = ['cordis', 'ptc', 'standard']

/** The one row this module switches off. */
const PLAN_MODE_ROW = 'plan-mode'

/** A startup failure carrying the plugin's name, so the log line is readable alone. */
function fail(message) {
	return new Error('[dsh-cursor-modes] ' + message)
}

/**
 * Find a row by id at any depth.
 *
 * `plan-mode` is not a top-level row: it sits inside the `planning` group, whose
 * children are that group's `config` array rather than the outer `plugins` one.
 * The walk descends into every `config` array instead of stopping one level down,
 * because the nesting is upstream's business - a group wrapped around the row
 * later must not turn this into a silent miss that a hand-written depth would.
 *
 * @param rows - plugin rows (or a group body) to search.
 * @param id - row id to find.
 * @returns the row, or undefined.
 */
export function findRowDeep(rows, id) {
	for (const row of rows ?? []) {
		if (row === null || typeof row !== 'object') continue
		if (row.id === id) return row
		if (Array.isArray(row.config)) {
			const nested = findRowDeep(row.config, id)
			if (nested !== undefined) return nested
		}
	}
	return undefined
}

/**
 * Read one shipped preset and switch its `plan-mode` row off.
 *
 * Two anchors on purpose. `base` locates the preset FILE, and only that - a
 * self-check points it at a fixture without having to fake `js-yaml` and
 * `@deepseek-ai/cordis-plugin-include` there too. The parser itself is always
 * resolved from this module, so the dialect a preset is read with never depends
 * on where the preset was found.
 *
 * @param id - preset id, which is also the shipped file stem.
 * @param base - anchor for the preset lookup; `import.meta.url` by default.
 * @returns the definition to register: the shipped declaration, its `order`
 *   included, with the one row edited.
 */
export async function derivePreset(id, base = import.meta.url) {
	const here = createRequire(import.meta.url)
	const presets = createRequire(base)
	const specifier = PRESET_DIR + '/' + id + '.patch.yml'

	let file
	try {
		file = presets.resolve(specifier)
	} catch (error) {
		// The documented alternatives (`agentPresets.readDocument`, the registry's
		// retained definitions) all need the shipped row to stay ENABLED, which is
		// the opposite of what claiming its id requires. Naming the failure and
		// stopping is the only honest answer; a guessed list is not one.
		throw fail('cannot resolve the shipped preset ' + specifier + ': ' + error.message)
	}

	const YAML = (await import(pathToFileURL(here.resolve('js-yaml')).href)).default
	const { entryListSchema } = await import(pathToFileURL(here.resolve('@deepseek-ai/cordis-plugin-include')).href)
	const rows = YAML.load(await readFile(file, 'utf8'), { schema: entryListSchema })

	// A shipped preset file is one patch entry that inserts the declaration, but
	// a bare row is just as legal, so both shapes are read rather than assumed.
	const declared = (Array.isArray(rows) ? rows : [])
		.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : [entry]))
		.find((entry) => entry?.id === 'preset-' + id)
	if (declared === undefined) throw fail(file + ': no entry with id "preset-' + id + '"')

	const config = declared.config ?? {}
	if (config.id !== id) {
		throw fail(file + ': preset-' + id + ' declares config.id ' + JSON.stringify(config.id) + ', expected ' + JSON.stringify(id))
	}
	if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
		throw fail(file + ': preset-' + id + ' declares no config.plugins list')
	}

	// Clone before editing: the parsed document stays a faithful copy of the file,
	// and the rows keep the `{ __jsExpr }` nodes the Loader expects.
	const plugins = structuredClone(config.plugins)
	const row = findRowDeep(plugins, PLAN_MODE_ROW)
	if (row === undefined) {
		throw fail(
			file + ': preset-' + id + ' has no "' + PLAN_MODE_ROW + '" row inside config.plugins. '
			+ 'Upstream moved or renamed it; switching a flag on some other row would disable '
			+ 'something else, so this stops instead of guessing.',
		)
	}
	row.disabled = true
	if (row.disabled !== true) throw fail(file + ': "' + PLAN_MODE_ROW + '" did not take disabled: true')

	// `order` is the shipped file's, never ours: a number written here would
	// reorder the preset chips on the next upstream release without a line of
	// ours changing, and the mistake would look like a UI bug.
	return { id, order: config.order, plugins }
}

/**
 * Derive every shipped preset and register it under the id the shipped row
 * would have used.
 *
 * Registration is all-or-nothing: a set that is half registered leaves the ids
 * it claimed unusable (the next load fails on `Duplicate agent preset` instead
 * of on the real cause), so a failure disposes whatever was already registered
 * before it rethrows.
 *
 * @param ctx - host context carrying `agentPresets`; the caller owns the
 *   returned disposer and must run it when the plugin unloads.
 * @param base - resolution anchor, passed through to {@link derivePreset}.
 * @returns a disposer that unregisters every preset registered here.
 */
export async function derivePresets(ctx, base = import.meta.url) {
	const disposers = []
	try {
		for (const id of PRESETS) {
			const definition = await derivePreset(id, base)
			try {
				disposers.push(await ctx.agentPresets.register(definition))
			} catch (error) {
				if (/Duplicate agent preset/.test(String(error?.message))) {
					throw fail(
						'preset ' + id + ' is already registered: ' + error.message + '\n'
						+ 'The shipped row is still enabled. Free the id in the profile patch first:\n'
						+ '  - id: preset-' + id + '\n    disabled: true',
					)
				}
				throw error
			}
			ctx.logger?.info?.(
				'dsh-cursor-modes: preset ' + id + ' derived from the shipped file (order '
				+ String(definition.order) + ', ' + PLAN_MODE_ROW + ' off)',
			)
		}
	} catch (error) {
		for (const dispose of disposers.reverse()) await dispose()
		throw error
	}
	return async () => {
		for (const dispose of disposers.reverse()) await dispose()
	}
}
