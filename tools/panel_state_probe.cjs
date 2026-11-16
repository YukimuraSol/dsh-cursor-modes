// panel_state_probe.cjs — self-check for dsh-cursor-modes' subagent-dropdown compaction
// (mountSubagentCompact: while >=1 row runs, only the running rows show plus a short
// "展开更多" card; clicking it flips to "收起"; no running row -> untouched panel).
//
// usage:  $env:DSH_ATTACH='3080'; node tools/panel_state_probe.cjs [cdpPort]
// exit 0 = PASS, 1 = FAIL, 2 = cannot verify (no panel with [role=treeitem][aria-level])
//
// It asserts DSH's DOM contract itself ([role=tree] / [role=treeitem][aria-level] /
// StateDot data-state), so if DSH re-words or re-structures that contract this probe goes red
// instead of letting the plugin silently stop working. Without a live subagent it synthesizes the
// running flag on a real row (data-state=ongoing) to exercise all three states, then restores it.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = process.env.DSH_ATTACH || "";
const CDP = Number(process.argv[2] || 9093);
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);

const PANEL_JS = "(() => { const roots = [...document.querySelectorAll('[role=tree]')].filter((n) => n.querySelector('[role=treeitem][aria-level]')); const root = roots[roots.length - 1]; if (!root) return JSON.stringify({ root: false }); const all = [...root.querySelectorAll('[role=treeitem][aria-level]')]; if (!all.length) return JSON.stringify({ root: true, rows: [] }); const levels = all.map((r) => parseInt(r.getAttribute('aria-level'), 10)); const min = Math.min.apply(null, levels); const top = all.filter((r) => parseInt(r.getAttribute('aria-level'), 10) === min); const rows = top.map((r) => { const dot = r.querySelector('[data-state]'); return { level: r.getAttribute('aria-level'), state: dot ? dot.getAttribute('data-state') : null, running: !!r.querySelector('[data-state=ongoing]'), visible: r.offsetParent !== null, label: (r.getAttribute('aria-label') || '').slice(0, 22) }; }); const card = document.querySelector('[data-dcm-expand-more]'); const txt = card ? card.querySelector('.dcm-expand-more-text') : null; const pth = card ? card.querySelector('path') : null; const cst = card ? getComputedStyle(card) : null; const crect = card ? card.getBoundingClientRect() : null; const host = card ? card.parentElement : null; const hrect = host ? host.getBoundingClientRect() : null; const visRow = top.filter(function (r) { return r.offsetParent !== null; })[0]; const rowBox = visRow ? (visRow.parentElement || visRow) : null; const rrect = rowBox ? rowBox.getBoundingClientRect() : null; const rcs = rowBox ? getComputedStyle(rowBox) : null; const roleCs = visRow ? getComputedStyle(visRow) : null; const caEl = visRow ? visRow.querySelector('[class*=clickarea]') : null; const caRect = caEl ? caEl.getBoundingClientRect() : null; const bodyEl = root.closest('[class*=ZKlsPq_menuBody]') || root.parentElement; const bodyRect = bodyEl ? bodyEl.getBoundingClientRect() : null; return JSON.stringify({ root: true, rows: rows, rowFill: caRect ? { left: Math.round(caRect.left), right: Math.round(caRect.right) } : null, panel: bodyRect ? { left: Math.round(bodyRect.left), right: Math.round(bodyRect.right) } : null, card: card ? { text: txt ? txt.textContent : null, arrow: pth ? (pth.getAttribute('transform') || '') : null, aria: card.getAttribute('aria-label'), height: Math.round(crect.height), width: Math.round(crect.width), x: Math.round(crect.left), y: crect.y, right: Math.round(crect.right), radius: cst.borderRadius, padding: cst.padding, marginLeft: cst.marginLeft, opacity: cst.opacity, bg: cst.backgroundColor, hostWidth: hrect ? Math.round(hrect.width) : null, rowLeft: rrect ? Math.round(rrect.left) : null, rowRight: rrect ? Math.round(rrect.right) : null, rowHeight: rrect ? Math.round(rrect.height) : null, rowRadius: rcs ? rcs.borderRadius : null, rowPadding: rcs ? rcs.padding : null, roleRadius: roleCs ? roleCs.borderRadius : null, css: !!document.querySelector('style[data-dcm-panel-css]') } : null }); })()";
const OPEN_JS = "(function () { if ([].slice.call(document.querySelectorAll('[role=tree]')).filter(function (n) { return n.querySelector('[role=treeitem][aria-level]'); }).length) return 'already-open'; var b = [].slice.call(document.querySelectorAll('button[aria-label]')).filter(function (n) { return (n.getAttribute('aria-label') || '').indexOf('个子智能体') >= 0; })[0]; if (!b) return 'no-trigger'; b.click(); return 'clicked'; })()";

async function main() {
  let token = "", port = PORT;
  if (/^\d+$/.test(PORT)) {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, ".dsh", "launch-token.json"), "utf8"));
    port = cfg.port; token = cfg.token;
  } else {
    console.error("usage: set DSH_ATTACH to the live port (e.g. 3080) or pass a port; this probe only drives an already running instance");
    process.exit(2);
  }
  console.log("attach mode: driving the running instance on " + port);
  const prof = path.join(os.tmpdir(), "dsh-panelprobe-" + CDP + "-" + process.pid);
  try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1440,900",
    "--remote-debugging-port=" + CDP, "--user-data-dir=" + prof, "about:blank"], { stdio: "ignore", windowsHide: true });
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    await sleep(200);
    try {
      const list = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
      const page = list.find((x) => x.type === "page");
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
  }
  if (!ws) { console.error("FAIL: could not attach to headless chrome"); chrome.kill(); process.exit(2); }
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: method, params: params || {} })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  for (const d of ["Page.enable", "Runtime.enable"]) await send(d);
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 140);
    return r && r.result ? r.result.value : undefined;
  };
  const state = async () => JSON.parse(await evalJs(PANEL_JS));
  const visible = (s) => s.rows.filter((r) => r.visible).length;
  const running = (s) => s.rows.filter((r) => r.running).length;
  const describe = (tag, s) => console.log(tag + ": rows=" + s.rows.length + " running=" + running(s) + " visible=" + visible(s)
    + " card=" + (s.card ? JSON.stringify(s.card.text) + " arrow=" + JSON.stringify(s.card.arrow) + " h=" + s.card.height + " css=" + s.card.css : "none"));
  const openPanel = async (index) => {
    await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/?token=" + token });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await sleep(500); ready = (await evalJs("document.querySelectorAll('[class*=sessionRow]').length")) > index; }
    await sleep(1500);
    const label = await evalJs("(function () { var rows = [].slice.call(document.querySelectorAll('[class*=sessionRow]')); var n = rows[" + index + "]; if (!n) return null; var t = (n.innerText || '').split(String.fromCharCode(10))[0].slice(0, 24); n.click(); return t; })()");
    if (label === null) return null;
    await sleep(6000);
    const opened = await evalJs(OPEN_JS);
    await sleep(1200);
    const s = await state();
    console.log("session[" + index + "] = " + JSON.stringify(label) + " trigger=" + opened + " rows=" + (s.rows ? s.rows.length : 0));
    if (!s.root || !s.rows || !s.rows.length) return null;
    return { index: index, label: label, state: s };
  };
  // rgB alpha of either computed form: "rgba(r, g, b, a)" or "color(srgb r g b / a)".
  const alpha = (v) => {
    if (!v) return null;
    let m = /\/\s*([\d.]+)\s*\)/.exec(v);
    if (m) return parseFloat(m[1]);
    m = /rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(v);
    if (m) return parseFloat(m[1]);
    return /^rgb\(/.test(v) ? 1 : null;
  };
  // real pointer hover (no click), then read the card back
  const hoverCard = async (card) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: card.x + card.width / 2, y: card.y + card.height / 2, button: "none", buttons: 0 });
    await sleep(600);
    const h = await state();
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 780, button: "none", buttons: 0 });
    await sleep(300);
    return h.card;
  };
  const dotExpr = (value) => "(function () { var root = [].slice.call(document.querySelectorAll('[role=tree]')).filter(function (n) { return n.querySelector('[role=treeitem][aria-level]'); }).pop(); var rows = [].slice.call(root.querySelectorAll('[role=treeitem][aria-level]')); var min = Math.min.apply(null, rows.map(function (r) { return parseInt(r.getAttribute('aria-level'), 10); })); var row = rows.filter(function (r) { return parseInt(r.getAttribute('aria-level'), 10) === min; })[0]; var dot = row.querySelector('[data-state]'); var old = dot.getAttribute('data-state'); dot.setAttribute('data-state', " + JSON.stringify(value) + "); return old; })()";

  const panels = [];
  for (const index of [1, 2, 3, 4, 5]) {
    const p = await openPanel(index);
    if (p) panels.push(p);
    if (panels.some((x) => running(x.state) > 0) && panels.some((x) => running(x.state) === 0)) break;
    if (panels.length >= 3) break;
  }
  if (!panels.length) {
    console.error("FAIL: no subagent panel with [role=treeitem][aria-level] rows in 5 sessions — contract unverifiable");
    chrome.kill(); process.exit(2);
  }

  const checks = {};
  const idleCase = panels.filter((p) => running(p.state) === 0)[0] || null;
  const runCase = panels.filter((p) => running(p.state) > 0)[0] || null;
  const first = panels[0].state;
  checks.contract_rows = first.rows.length > 0;
  checks.contract_level = first.rows.every((r) => r.level !== null);
  checks.contract_dot = first.rows.every((r) => r.state !== null);

  if (idleCase) {
    console.log("idle panel   : " + JSON.stringify(idleCase.label));
    describe("idle-initial", idleCase.state);
    checks.idle_all_visible = visible(idleCase.state) === idleCase.state.rows.length;
    checks.idle_no_card = idleCase.state.card === null;
  }
  if (runCase) {
    console.log("running panel: " + JSON.stringify(runCase.label));
    describe("run-initial ", runCase.state);
    checks.real_running_collapsed = visible(runCase.state) === running(runCase.state);
    checks.real_running_card = !!runCase.state.card && runCase.state.card.text === "展开更多" && runCase.state.card.arrow === "";
    if (runCase.state.card) checks.real_running_grid = (runCase.state.card.height === 28 || runCase.state.card.height === 30) && runCase.state.card.radius === "7px";
    checks.real_running_row_left = !!runCase.state.rowFill && !!runCase.state.panel && Math.abs(runCase.state.rowFill.left - runCase.state.panel.left) <= 1;
  } else {
    console.log("running panel: none on 3080 right now — real-running assertions skipped this run");
  }

  // Toggle cycle on a panel WITHOUT a real running row when one exists, so the collapse we then
  // observe is purely the plugin reacting to a state flip; otherwise on the last panel opened.
  const cycleTarget = idleCase || panels[panels.length - 1];
  const target = await openPanel(cycleTarget.index);
  if (!target) { console.error("FAIL: could not reopen a panel for the toggle cycle"); chrome.kill(); process.exit(2); }
  let s = target.state;
  describe("cycle-initial", s);
  if (running(s) === 0) checks.cycle_idle_no_card = s.card === null && visible(s) === s.rows.length;

  const oldState = await evalJs(dotExpr("ongoing"));
  if (typeof oldState !== "string" || oldState.indexOf("EXC") === 0) { console.error("FAIL: could not flip the row state — " + oldState); chrome.kill(); process.exit(2); }
  await sleep(900);
  s = await state();
  describe("synthetic-run", s);
  checks.synth_collapsed = running(s) > 0 && visible(s) === running(s);
  checks.synth_card = !!s.card && s.card.text === "展开更多" && s.card.arrow === "" && s.card.css === true;
  if (s.card) {
    checks.synth_card_grid = s.card.height === 28 || s.card.height === 30; // contract: the short card, the pick between 28 and 30
    checks.synth_card_radius = s.card.radius === "7px" && s.card.roleRadius === "7px";
    checks.synth_card_column = s.card.marginLeft === "0px" && s.card.width === s.card.hostWidth;
    checks.synth_card_right_edge = Math.abs(s.card.right - s.card.rowRight) <= 1;
    // the card spans the row CLICK AREA (not the row text column): left edge on the panel content box
    checks.synth_card_left_edge = Math.abs(s.card.x - s.card.rowLeft) <= 2;
    // the row's hover fill must start on the panel content box (the card's left edge), not 20px in
    checks.synth_row_fill_left = !!s.rowFill && !!s.panel && Math.abs(s.rowFill.left - s.panel.left) <= 1;
    checks.synth_row_fill_right = !!s.rowFill && !!s.panel && Math.abs(s.rowFill.right - s.panel.right) <= 1;
    checks.synth_row_card_aligned = !!s.rowFill && Math.abs(s.card.x - s.rowFill.left) <= 1 && Math.abs(s.card.right - s.rowFill.right) <= 1;
    checks.synth_card_rest_light = alpha(s.card.bg) !== null && alpha(s.card.bg) < 0.1;
    checks.synth_card_rest_opacity = parseFloat(s.card.opacity) >= 0.98;
    const hovered = await hoverCard(s.card);
    checks.synth_card_hover_brighter = !!hovered && alpha(hovered.bg) > alpha(s.card.bg) && parseFloat(hovered.opacity) >= parseFloat(s.card.opacity);
    console.log("card geometry: " + JSON.stringify({ h: s.card.height, w: s.card.width, marginLeft: s.card.marginLeft, left: s.card.x, rowLeft: s.card.rowLeft, rowFill: s.rowFill, panel: s.panel, hostWidth: s.card.hostWidth, right: s.card.right, rowRight: s.card.rowRight, rowHeight: s.card.rowHeight, radius: s.card.radius, roleRadius: s.card.roleRadius, restBg: s.card.bg, restOpacity: s.card.opacity, hoverBg: hovered ? hovered.bg : null, hoverOpacity: hovered ? hovered.opacity : null }));
  }
  // Click storm (report round 10): the compaction's MutationObserver must not self-excite.
  // Real CDP clicks on the card, each round trip time-capped, plus a sync-count ceiling.
  if (s.card) {
    const statsJs = "(function () { return window.__dcmPanelStats ? JSON.stringify(window.__dcmPanelStats()) : 'none'; })()";
    const centerJs = "(function () { var c = document.querySelector('[data-dcm-expand-more]'); if (!c) return null; var r = c.getBoundingClientRect(); if (!r.width) return null; return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()";
    const readStats = async () => { const raw = await evalJs(statsJs); if (typeof raw !== "string" || raw === "none") return null; try { return JSON.parse(raw); } catch (e) { return null; } };
    const before = await readStats();
    checks.storm_stats_available = !!before;
    let slow = 0, missing = 0;
    const N = 8;
    for (let i = 0; i < N; i++) {
      const c = JSON.parse(await evalJs(centerJs) || "null");
      if (!c) { missing++; break; }
      const t0 = Date.now();
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", buttons: 1, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", buttons: 0, clickCount: 1 });
      if (Date.now() - t0 > 300) slow++;
      await sleep(60);
    }
    const after = await readStats();
    checks.storm_clicks_answered = missing === 0 && slow === 0;
    checks.storm_syncs_bounded = !!after && !after.stopped && (before === null || (after.syncs - before.syncs) <= 10 * N);
    console.log("click storm: " + N + " clicks, slow=" + slow + " missing=" + missing
      + " syncs " + (before ? before.syncs : "?") + "->" + (after ? after.syncs : "?") + " writes " + (before ? before.writes : "?") + "->" + (after ? after.writes : "?")
      + " stopped=" + (after ? after.stopped : "?"));
  }

  const clicked = await evalJs("(function () { var c = document.querySelector('[data-dcm-expand-more]'); if (!c) return false; c.click(); return true; })()");
  await sleep(700);
  s = await state();
  describe("expanded    ", s);
  checks.click_found = clicked === true;
  checks.expand_all_visible = visible(s) === s.rows.length;
  checks.expand_label = !!s.card && s.card.text === "收起" && s.card.arrow === "rotate(180 8 8)";

  await evalJs("(function () { var c = document.querySelector('[data-dcm-expand-more]'); if (c) c.click(); })()");
  await sleep(700);
  s = await state();
  describe("re-collapsed", s);
  checks.recollapse_hides = visible(s) === running(s);
  checks.recollapse_label = !!s.card && s.card.text === "展开更多" && s.card.arrow === "";

  await evalJs(dotExpr(oldState));
  await sleep(900);
  s = await state();
  describe("restored    ", s);
  if (running(s) > 0) {
    checks.restore_card_stays = !!s.card && s.card.text === "展开更多";
    checks.restore_running_only = visible(s) === running(s);
  } else {
    checks.restore_no_card = s.card === null;
    checks.restore_all_visible = visible(s) === s.rows.length;
  }

  const names = Object.keys(checks);
  const bad = names.filter((n) => checks[n] !== true);
  console.log("checks: " + names.map((n) => n + "=" + checks[n]).join(" "));
  chrome.kill();
  if (bad.length) { console.error("FAIL: " + bad.join(", ")); process.exit(1); }
  console.log("PASS: panel_state_probe — run-only collapsed view, 展开更多 card, expand/collapse toggle and the idle panel all hold");
  process.exit(0);
}
main().catch((e) => { console.error("probe crashed: " + (e && e.stack ? e.stack : e)); process.exit(2); });
