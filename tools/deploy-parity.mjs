/**
 * Deploy parity: the three copies of this plugin must agree.
 *
 *   repo (source of truth)  ->  body (launcher's .dsh-launcher-plugin-bodies)
 *                           ->  node_modules (what the process actually imports)
 *
 * A stale node_modules copy silently runs OLD code: that is how LIMIT=3 stayed
 * live on 4000 while the source said 10 (finding, 2026-11-12).
 *
 *   node tools/deploy-parity.mjs [repoRoot] [bodyDir] [nodeModulesDir]
 *
 * Every file the installed copy ships must be byte-identical in all three.
 * Repo-only material (docs, .bak, self-checks) is reported, never failed.
 * Exit 0 = parity holds, 1 = drift (file + both shas).
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

const shipped = installed(nm)
const rows = []
let drift = 0
for (const rel of shipped) {
  const a = sha(join(repo, rel))
  const b = sha(join(body, rel))
  const c = sha(join(nm, rel))
  if (a !== b || b !== c) { drift += 1; rows.push({ file: rel, repo: a, body: b, node_modules: c }) }
}

if (drift === 0) {
  console.log('deploy parity: OK (' + shipped.length + ' shipped files identical in repo / body / node_modules)')
  process.exit(0)
}
console.log('deploy parity: DRIFT in ' + drift + ' of ' + shipped.length + ' shipped files')
for (const r of rows) console.log('  ' + r.file.padEnd(26) + ' repo=' + r.repo + ' body=' + r.body + ' nm=' + r.node_modules)
process.exit(1)
