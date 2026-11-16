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
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

const repo = process.argv[2] ?? 'D:/cursor编程文件/工作区1相关/工作区1/具体项目/DSH自研插件/dsh-cursor-modes'
const body = process.argv[3] ?? 'D:/DSH Pack Launcher/dsh-packs/dsh-fallback-4000/profiles/web/.dsh-launcher-plugin-bodies/dsh-cursor-modes'
const nm = process.argv[4] ?? 'D:/DSH Pack Launcher/dsh-packs/dsh-fallback-4000/profiles/web/node_modules/dsh-cursor-modes'

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
for (const rel of manifest()) {
  if (seen.has(rel)) continue
  const b = sha(join(body, rel))
  const c = sha(join(nm, rel))
  if (b === 'MISSING' || c === 'MISSING') {
    drift += 1
    rows.push({ file: rel, repo: sha(join(repo, rel)), body: b, node_modules: c })
  }
}

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
