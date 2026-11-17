/**
 * Deploy parity: the three copies of this plugin must agree.
 *
 *   repo (source of truth)  ->  body (launcher's .dsh-launcher-plugin-bodies)
 *                           ->  node_modules (what the process actually imports)
 *
 * A stale node_modules copy silently runs OLD code: that is how a stale constant
 * stayed live on 4000 for days while the source already said otherwise
 * (finding, 2026-11-12).
 *
 *   node tools/deploy-parity.mjs [repoRoot] [bodyDir] [nodeModulesDir]
 *
 * Every file the installed copy ships must be byte-identical in all three.
 * Repo-only material (docs, .bak, self-checks) is reported, never failed.
 * Exit 0 = parity holds, 1 = drift (file + both shas).
 *
 * 2026-11-16 — INSTALL-ONLY is not drift. The install side grows files the repo
 * never had and never will: `_reports/` holds self-check logs and judge-parity
 * verdicts written where the plugin runs. Treating "repo=MISSING" as DRIFT made
 * this tool red on every run (3080: 1 of 39, 4000: 10 of 40) for a condition no
 * action can clear, which is the same as having no alarm. Such a file is now
 * listed and labelled `install-only kept`: it fails nothing as long as body and
 * node_modules agree with each other — if those two disagree nobody can say
 * which copy is right, so that stays DRIFT.
 *
 * The reverse case used to be invisible: the iteration source is node_modules, so
 * a file the manifest promises but the install side lacks was never looked at.
 * The shipped manifest (package.json `files` + package.json + cordis.patch.yml)
 * is now checked for presence on both install copies.
 *
 * 2026-11-17 — a `files` entry may name a DIRECTORY (`extension/`), and there is
 * nothing to hash in one: the shipped walk already judges every file inside it.
 * Hashing the entry itself threw EISDIR in the manifest loop and killed the whole
 * run before it printed a comparison, so a plugin with a directory in `files`
 * (dsh-ui-block) read as "crashed" instead of OK or DRIFT. Directory entries are
 * now skipped and reported as `files[] dir skipped`: contents stay the walk's job.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Nothing here is baked in: the repo is this file's parent, and the install side
// is <DSH_HOME>/profiles/<profile> — the layout the launcher uses. Another home or
// profile: set DSH_HOME / DSH_PROFILE, or pass the three arguments.
const repo = process.argv[2] ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE?.trim() || 'web'
const body =
  process.argv[3] ?? join(dshHome, 'profiles', profile, '.dsh-launcher-plugin-bodies', 'dsh-cursor-modes')
const nm = process.argv[4] ?? join(dshHome, 'profiles', profile, 'node_modules', 'dsh-cursor-modes')

// A missing install side is a setup problem, not parity: say where to point it.
for (const [dir, what] of [[body, 'body dir'], [nm, 'node_modules dir']]) {
  if (!existsSync(dir)) {
    console.error(`missing ${what}: ${dir}\n` +
      'Point this at the instance whose copies you are comparing:\n' +
      '  DSH_HOME=<its home> [DSH_PROFILE=<its profile>] node tools/deploy-parity.mjs\n' +
      '  or pass them: node tools/deploy-parity.mjs [repoRoot] <bodyDir> <nodeModulesDir>')
    process.exit(2)
  }
}

const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) : 'MISSING')

function installed(root) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (statSync(p).isFile() && !/\.bak/.test(e.name)) out.push(relative(root, p).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return out.sort()
}

/** Files the package promises to ship: they must exist on BOTH install copies. */
function manifest() {
  const out = []
  try {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    for (const rel of pkg.files ?? []) out.push(rel)
  } catch {
    // no readable manifest: the shipped walk still covers everything installed
  }
  out.push('package.json', 'cordis.patch.yml')
  return out
}

const shipped = installed(nm)
const rows = []
const kept = []
let drift = 0
for (const rel of shipped) {
  const a = sha(join(repo, rel))
  const b = sha(join(body, rel))
  const c = sha(join(nm, rel))
  if (a === 'MISSING') {
    // The repo never had this file. It is install-side material (a self-check log
    // under _reports/), so it cannot be "brought into parity" by any edit here.
    if (b === c) kept.push({ file: rel, body: b, node_modules: c })
    else { drift += 1; rows.push({ file: rel, repo: a, body: b, node_modules: c }) }
    continue
  }
  if (a !== b || b !== c) { drift += 1; rows.push({ file: rel, repo: a, body: b, node_modules: c }) }
}

// Promised but not installed: the case the node_modules walk cannot see.
const seen = new Set(shipped)
const dirs = []
for (const rel of manifest()) {
  if (seen.has(rel)) continue
  // A directory entry has no byte content; the shipped walk above lists its files.
  if ([repo, body, nm].some((p) => statSync(join(p, rel), { throwIfNoEntry: false })?.isDirectory())) {
    dirs.push(rel)
    continue
  }
  const b = sha(join(body, rel))
  const c = sha(join(nm, rel))
  if (b === 'MISSING' || c === 'MISSING') {
    drift += 1
    rows.push({ file: rel, repo: sha(join(repo, rel)), body: b, node_modules: c })
  }
}

for (const rel of dirs) console.log('  files[] dir skipped  ' + rel + '  (contents judged by the shipped walk)')
if (kept.length > 0) {
  for (const k of kept) console.log('  install-only kept  ' + k.file + '  body=' + k.body + ' nm=' + k.node_modules)
}
if (drift === 0) {
  console.log('deploy parity: OK (' + shipped.length + ' shipped, ' + kept.length + ' install-only kept)')
  process.exit(0)
}
console.log('deploy parity: DRIFT in ' + drift + ' of ' + shipped.length + ' shipped files')
for (const r of rows) console.log('  ' + r.file.padEnd(46) + ' repo=' + r.repo + ' body=' + r.body + ' nm=' + r.node_modules)
process.exit(1)
