import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

/**
 * Plan-file naming and landing: the deterministic slug, the frontmatter, and
 * the write. Pure except for `writePlanFile`, so the self-check shares exactly
 * the functions the host plugin runs.
 *
 * Named `planfile.js`, not the planned `files.js`, because `/files` resolves
 * into the plan text.
 *
 * @module dsh-cursor-plan/planfile
 */

/**
 * Directory holding plan files, created on first write.
 *
 * The pack is the home: when the harness runs from a pack, `DSH_HOME` is the
 * pack root and the plans land in `<DSH_HOME>/plans` — not in the user's
 * `~/.dsh`, which would leak session-local artifacts onto C:.
 * An explicit `home` keeps the old `<home>/.dsh/plans` shape.
 */
export function plansDir(home) {
	if (typeof home === 'string' && home !== '') return join(home, '.dsh', 'plans');
	const dshHome = process.env.DSH_HOME;
	if (typeof dshHome === 'string' && dshHome !== '') return join(dshHome, 'plans');
	return join(homedir(), '.dsh', 'plans');
}

/**
 * Cursor's `sanitizeFileName`: lowercase, replace filesystem-reserved
 * characters, whitespace to `_`, squeeze repeated `_`, trim `_`, truncate.
 * CJK is preserved (it is not in the reserved set).
 *
 * ponytail: naive code-unit slice at 100. A surrogate pair straddling the cut
 * would split; names that long are already degenerate, and the upgrade path is
 * `Array.from(name).slice(0, 100).join('')`.
 *
 * @param {string} name
 * @returns {string} slug, or `'plan'` when sanitizing left nothing.
 */
export function sanitizeName(name) {
	const raw = typeof name === 'string' ? name : '';
	const slug = raw
		.toLowerCase()
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
		.replace(/\s+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 100);
	return slug === '' ? 'plan' : slug;
}

/**
 * Mint the plan file's base name: `<slug>_<8 hex>`.
 *
 * @param {string} name
 * @param {() => Buffer} [random] injectable entropy for the self-check.
 * @returns {string}
 */
export function planFileBase(name, random = () => randomBytes(4)) {
	return `${sanitizeName(name)}_${random().toString('hex')}`;
}

/** Absolute path of the plan file, `<plansDir>/<base>.plan.md`. */
export function planFilePath(name, options = {}) {
	const base = options.base ?? planFileBase(name, options.random);
	return join(options.dir ?? plansDir(options.home), `${base}.plan.md`);
}

/**
 * Build the file's text: YAML frontmatter, one blank line, then the plan body.
 * `js-yaml` owns the quoting (a hand-rolled emitter gets `overview: It's …`
 * wrong), and the markdown fence wrapper keeps block scalars indented safely.
 *
 * @param {{ name?: string, overview?: string, todos?: unknown[], plan: string }} fields
 * @returns {string}
 */
export function planFileText({ name, overview, todos, plan }) {
	const frontmatter = {};
	if (typeof name === 'string' && name !== '') frontmatter.name = name;
	if (typeof overview === 'string' && overview !== '') frontmatter.overview = overview;
	if (Array.isArray(todos) && todos.length > 0) frontmatter.todos = todos;
	frontmatter.isProject = false;
	const body = typeof plan === 'string' ? plan.trim() : '';
	const head = yaml.dump(frontmatter, { lineWidth: -1, noRefs: true }).trimEnd();
	return `---\n${head}\n---\n\n${body}\n`;
}

/**
 * Land one plan file. Returns the absolute path; the model result embeds it as
 * `Plan file: <path>`, which is what the client card scrapes.
 *
 * @param {{ name: string, overview?: string, todos?: unknown[], plan: string }} fields
 * @param {{ home?: string, dir?: string, base?: string, random?: () => Buffer }} [options]
 * @returns {{ path: string, text: string }}
 */
export function writePlanFile(fields, options = {}) {
	const dir = options.dir ?? plansDir(options.home);
	const path = planFilePath(fields.name, { ...options, dir });
	const text = planFileText(fields);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, text, 'utf8');
	return { path, text };
}

/**
 * The frontmatter span of a plan file: the opening fence, the YAML head, the
 * closing fence and the newline that ends it. The body stays byte for byte
 * whatever the caller does with the head.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * The dispatch stamp a plan file carries in its frontmatter.
 *
 * `dispatched` is an ISO-8601 timestamp written by the Build bridge once a build
 * was actually handed to the session, and `dispatchedChoice` records which
 * button was pressed. A missing/blank field means "never dispatched" (every plan
 * written before this field existed). A present but unparseable value is
 * reported as `invalid` and treated as NOT dispatched, so a hand-edited file can
 * never hide the buttons behind a typo.
 *
 * @param {string} path absolute path of the plan file.
 * @returns {{ exists: boolean, dispatched: boolean, choice?: string, at?: string, invalid?: string }}
 */
export function readPlanDispatch(path) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return { exists: false, dispatched: false };
	}
	const match = FRONTMATTER.exec(text);
	if (match === null) return { exists: true, dispatched: false };
	let head;
	try {
		head = yaml.load(match[1]);
	} catch {
		return { exists: true, dispatched: false };
	}
	if (head === null || typeof head !== 'object' || Array.isArray(head)) return { exists: true, dispatched: false };
	const value = head.dispatched;
	if (value === undefined || value === null || value === '') return { exists: true, dispatched: false };
	if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
		return { exists: true, dispatched: false, invalid: String(value) };
	}
	return {
		exists: true,
		dispatched: true,
		choice: typeof head.dispatchedChoice === 'string' ? head.dispatchedChoice : undefined,
		at: value
	};
}

/**
 * Stamp one dispatched plan. Reads the file first, patches only the two dispatch
 * keys, and lets js-yaml re-emit the head, so every other field (name, overview,
 * todos, isProject, anything a newer host adds) survives untouched and the body
 * is replaced byte for byte. Never hand-builds YAML.
 *
 * @param {string} path absolute path of the plan file.
 * @param {'multi'|'default'} choice which Build button was pressed.
 * @param {string} [at] ISO timestamp; defaults to now.
 * @returns {{ at: string, choice: string }} what was written.
 */
export function markPlanDispatched(path, choice, at = new Date().toISOString()) {
	const text = readFileSync(path, 'utf8');
	const match = FRONTMATTER.exec(text);
	if (match === null) throw new Error('plan file has no frontmatter: ' + path);
	const head = yaml.load(match[1]);
	if (head === null || typeof head !== 'object' || Array.isArray(head)) {
		throw new Error('plan file frontmatter is not a mapping: ' + path);
	}
	head.dispatched = at;
	if (choice === 'multi' || choice === 'default') head.dispatchedChoice = choice;
	const dumped = yaml.dump(head, { lineWidth: -1, noRefs: true }).trimEnd();
	const body = text.slice(match[0].length);
	writeFileSync(path, `---\n${dumped}\n---\n${body}`, 'utf8');
	return { at, choice };
}
