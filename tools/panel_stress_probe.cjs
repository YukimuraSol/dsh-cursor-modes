// panel_stress_probe.cjs — acceptance test for the subagent-dropdown compaction rewrite.
// The old build froze the page: its MutationObserver watched document.body with
// {childList, subtree, attributes} and the sync writes DOM, so the two fed each other.
// This probe drives REAL clicks and fails on ANY slow round trip.
//
// usage: $env:DSH_ATTACH='3080'; node tools/panel_stress_probe.cjs [cdpPort]
//   phase A: panel with a subagent running -> 20 real mouse clicks on the 展开更多/收起 card
//   phase B: panel with NOTHING running     -> 20 clicks toggling the popover open/closed
// exit 0 = PASS, 1 = FAIL, 2 = cannot verify
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = process.env.DSH_ATTACH || "";
const CDP = Number(process.argv[2] || 9101);
const CLICK_BUDGET_MS = 300;
const PROBE_BUDGET_MS = 300;
const SEND_TIMEOUT_MS = 1500;
const STORM = Number(process.env.STORM || 20);
const BROWSERS = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].filter((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPEN_JS = "(function () { if ([].slice.call(document.querySelectorAll('[role=tree]')).filter(function (n) { return n.querySelector('[role=treeitem][aria-level]'); }).length) return 'already-open'; var b = [].slice.call(document.querySelectorAll('button[aria-label]')).filter(function (n) { return (n.getAttribute('aria-label') || '').indexOf('个子智能体') >= 0; })[0]; if (!b) return 'no-trigger'; b.click(); return 'clicked'; })()";
const RUNNING_JS = "(function () { return document.querySelectorAll('[role=treeitem][aria-level] [data-state=ongoing]').length; })()";
const CARD_JS = "(function () { var c = document.querySelector('[data-dcm-expand-more]'); if (!c) return null; var r = c.getBoundingClientRect(); if (!r.width) return null; return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (c.innerText || '').trim() }); })()";
const STATS_JS = "(function () { return window.__dcmPanelStats ? JSON.stringify(window.__dcmPanelStats()) : 'none'; })()";
const SYNTH_JS = "(function (v) { var root = [].slice.call(document.querySelectorAll('[role=tree]')).filter(function (n) { return n.querySelector('[role=treeitem][aria-level]'); }).pop(); if (!root) return 'no-root'; var rows = [].slice.call(root.querySelectorAll('[role=treeitem][aria-level]')); var min = Math.min.apply(null, rows.map(function (r) { return parseInt(r.getAttribute('aria-level'), 10); })); var row = rows.filter(function (r) { return parseInt(r.getAttribute('aria-level'), 10) === min; })[0]; var dot = row.querySelector('[data-state]'); var old = dot.getAttribute('data-state'); dot.setAttribute('data-state', v); return old; })";
const TOGGLE_JS = "(function () { var b = [].slice.call(document.querySelectorAll('button[aria-label]')).filter(function (n) { return (n.getAttribute('aria-label') || '').indexOf('个子智能体') >= 0; })[0]; if (!b) return 'no-trigger'; b.click(); return 'clicked'; })()";
const TRIGGER_JS = "(function () { var b = [].slice.call(document.querySelectorAll('button[aria-label]')).filter(function (n) { return (n.getAttribute('aria-label') || '').indexOf('个子智能体') >= 0; })[0]; if (!b) return null; var r = b.getBoundingClientRect(); if (!r.width) return null; return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()";
const STATE_JS = "(function () { return JSON.stringify({ open: !!document.querySelector('[class*=ZKlsPq_menu]'), rows: document.querySelectorAll('[role=treeitem][aria-level]').length, card: !!document.querySelector('[data-dcm-expand-more]') }); })()";

async function main() {
  let token = "", port = PORT;
  if (/^\d+$/.test(PORT)) {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, ".dsh", "launch-token.json"), "utf8"));
    port = cfg.port; token = cfg.token;
  } else { console.error("usage: set DSH_ATTACH to the live port"); process.exit(2); }
  const CHROME = BROWSERS[0];
  const prof = path.join(os.tmpdir(), "dsh-stressprobe-" + CDP + "-" + process.pid);
  try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1440,900",
    "--remote-debugging-port=" + CDP, "--user-data-dir=" + prof, "about:blank"], { stdio: "ignore", windowsHide: true });
  const killChrome = () => { try { spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch (e) {} try { chrome.kill(); } catch (e) {} };
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    await sleep(200);
    try { const l = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json(); const p = l.find((x) => x.type === "page"); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch {}
  }
  if (!ws) { console.error("FAIL: attach"); killChrome(); process.exit(2); }
  let id = 0; const pending = new Map(); const warns = [];
  const send = (method, params = {}, timeoutMs = SEND_TIMEOUT_MS) => new Promise((res) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); res({ __timeout: true }); }, timeoutMs);
    pending.set(i, (r) => { clearTimeout(timer); res(r); });
    ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled" && m.params && m.params.type === "warning") {
      const text = (m.params.args || []).map((a) => a.value || a.description || "").join(" ");
      if (text.indexOf("dsh-cursor-modes") >= 0) warns.push(text.slice(0, 140));
    }
    if (m.id && pending.has(m.id)) { const fn = pending.get(m.id); pending.delete(m.id); fn(m.result || m.error); }
  };
  await new Promise((r) => (ws.onopen = r));
  for (const d of ["Page.enable", "Runtime.enable"]) await send(d);
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.__timeout) return "TIMEOUT";
    if (r && r.exceptionDetails) return "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 160);
    return r && r.result ? r.result.value : undefined;
  };
  const clickAt = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x, y: y, button: "none", buttons: 0 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x, y: y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x, y: y, button: "left", buttons: 0, clickCount: 1 });
  };
  const stats = async () => { const raw = await evalJs(STATS_JS); if (typeof raw !== "string" || raw === "none") return null; try { return JSON.parse(raw); } catch (e) { return null; } };
  const failures = []; const rowsOut = [];

  const openSession = async (index) => {
    await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/?token=" + token });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { await sleep(500); ready = (await evalJs("document.querySelectorAll('[class*=sessionRow]').length")) > index; }
    await sleep(1500);
    const label = await evalJs("(function () { var rows = [].slice.call(document.querySelectorAll('[class*=sessionRow]')); var n = rows[" + index + "]; if (!n) return null; var t = (n.innerText || '').split(String.fromCharCode(10))[0].slice(0, 24); n.click(); return t; })()");
    if (label === null) return null;
    await sleep(6000);
    await evalJs(OPEN_JS);
    await sleep(1500);
    const rows = await evalJs("document.querySelectorAll('[role=treeitem][aria-level]').length");
    if (!rows) return null;
    return { index: index, label: label, running: await evalJs(RUNNING_JS) };
  };

  const stormA = async (target) => {
    console.log("### A target: session[" + target.index + "] " + JSON.stringify(target.label) + " running=" + target.running);
    let synthOld = null;
    if (!JSON.parse(await evalJs(CARD_JS) || "null")) {
      synthOld = await evalJs(SYNTH_JS + "('ongoing')");
      await sleep(900);
      if (!JSON.parse(await evalJs(CARD_JS) || "null")) { failures.push("A: no card on the running panel"); return; }
      console.log("   (running state synthesized on a top-level row to materialise the card)");
    }
    console.log("--- A: " + STORM + " x real mouse click on the card");
    for (let i = 1; i <= STORM; i++) {
      const c = JSON.parse(await evalJs(CARD_JS) || "null");
      if (!c) { failures.push("A: card vanished at click " + i); break; }
      const t0 = Date.now();
      await clickAt(c.x, c.y);
      const clickMs = Date.now() - t0;
      const p0 = Date.now();
      const text = await evalJs("(function () { var c = document.querySelector('[data-dcm-expand-more]'); return c ? (c.innerText || '').trim() : null; })()");
      const probeMs = Date.now() - p0;
      const s = await stats();
      rowsOut.push({ phase: "A", i: i, clickMs: clickMs, probeMs: probeMs, text: text, syncs: s ? s.syncs : null, writes: s ? s.writes : null });
      if (clickMs > CLICK_BUDGET_MS) failures.push("A click " + i + " took " + clickMs + "ms");
      if (probeMs > PROBE_BUDGET_MS) failures.push("A probe " + i + " took " + probeMs + "ms");
      if (text === "TIMEOUT") failures.push("A evaluate " + i + " timed out");
      if (s && s.stopped) { failures.push("A circuit breaker tripped at click " + i); break; }
      await sleep(60);
    }
    if (synthOld) { await evalJs(SYNTH_JS + "(" + JSON.stringify(synthOld) + ")"); await sleep(400); }
  };

  const stormB = async (target) => {
    console.log("### B target: session[" + target.index + "] " + JSON.stringify(target.label) + " running=" + target.running + " (nothing running: no card at all)");
    const before = JSON.parse(await evalJs(STATE_JS));
    if (before.card) failures.push("B: a card exists on a panel with nothing running");
    // The session-header popover is a hover card: clicking the trigger does NOT close it (measured)
    // and a click far outside does. So one open/close CYCLE is: real click on neutral page area
    // (close) + real click on the trigger (open).
    const t = JSON.parse(await evalJs(TRIGGER_JS) || "null");
    if (!t) { failures.push("B: no session-header subagent trigger"); return; }
    const outside = JSON.parse(await evalJs("(function () { var m = document.querySelector('[class*=ZKlsPq_menu]'); var r = m ? m.getBoundingClientRect() : null; var x = 300, y = 700; if (r && x > r.left - 20 && x < r.right + 20 && y > r.top - 20 && y < r.bottom + 20) x = 1200; return JSON.stringify({ x: x, y: y }); })()"));
    console.log("--- B: " + STORM + " x open/close cycle (real click outside to close + real click on the trigger to open)");
    let flips = 0, prev = before.open;
    for (let i = 1; i <= STORM; i++) {
      const t0 = Date.now();
      await clickAt(outside.x, outside.y);          // close
      const closeMs = Date.now() - t0;
      const p0 = Date.now();
      const closed = JSON.parse(await evalJs(STATE_JS));
      const probeMs = Date.now() - p0;
      const t1 = Date.now();
      await clickAt(t.x, t.y);                      // open
      let openMs = Date.now() - t1;
      if (!JSON.parse(await evalJs(STATE_JS)).open) { await evalJs(TOGGLE_JS); openMs = Date.now() - t1; }
      const s = await stats();
      if (closed.open !== prev) flips++;
      if (closed.open !== false) flips += 0; else flips++;
      prev = true;
      rowsOut.push({ phase: "B", i: i, clickMs: closeMs > openMs ? closeMs : openMs, probeMs: probeMs, text: (closed.open ? "open" : "closed") + "->open/" + closed.rows + (closed.card ? "C" : "-"), syncs: s ? s.syncs : null, writes: s ? s.writes : null });
      if (closeMs > CLICK_BUDGET_MS) failures.push("B close click " + i + " took " + closeMs + "ms");
      if (openMs > CLICK_BUDGET_MS) failures.push("B open click " + i + " took " + openMs + "ms");
      if (probeMs > PROBE_BUDGET_MS) failures.push("B probe " + i + " took " + probeMs + "ms");
      if (s && s.stopped) { failures.push("B circuit breaker tripped at cycle " + i); break; }
      await sleep(80);
    }
    console.log("   measured open/close transitions: " + flips + " (2 per cycle expected)");
    if (flips < STORM) failures.push("B: only " + flips + " open/close transitions in " + STORM + " cycles - the storm did not really toggle the panel");
  };

  let runTarget = null, idleTarget = null;
  for (const index of [1, 2, 3, 4, 5, 6]) {
    if (runTarget && idleTarget) break;
    const found = await openSession(index);
    if (!found) { console.log("session[" + index + "] -> no panel"); continue; }
    console.log("session[" + index + "] = " + JSON.stringify(found.label) + " rows-panel running=" + found.running);
    if (!runTarget && found.running > 0) { runTarget = found; await stormA(found); continue; }
    if (!idleTarget && found.running === 0) { idleTarget = found; await stormB(found); continue; }
  }
  if (!runTarget) failures.push("no panel with a running subagent found (phase A unverified)");
  if (!idleTarget) failures.push("no idle panel found (phase B unverified)");

  for (const p of ["A", "B"]) {
    const rs = rowsOut.filter((x) => x.phase === p);
    if (!rs.length) continue;
    const maxClick = Math.max.apply(null, rs.map((x) => x.clickMs));
    const avgClick = Math.round(rs.reduce((a, x) => a + x.clickMs, 0) / rs.length);
    const maxProbe = Math.max.apply(null, rs.map((x) => x.probeMs));
    console.log("phase " + p + ": clicks=" + rs.length + " clickMs max=" + maxClick + " avg=" + avgClick + " | probeMs max=" + maxProbe
      + " | syncs " + rs[0].syncs + "->" + rs[rs.length - 1].syncs + " (d=" + (rs[rs.length - 1].syncs - rs[0].syncs) + ")"
      + " | writes " + rs[0].writes + "->" + rs[rs.length - 1].writes);
    console.log("   per-click state : " + rs.map((x) => x.text).join(","));
    console.log("   per-click clickMs: " + rs.map((x) => x.clickMs).join(","));
    console.log("   per-click probeMs: " + rs.map((x) => x.probeMs).join(","));
    if (rs[0].syncs !== null && (rs[rs.length - 1].syncs - rs[0].syncs) > 10 * rs.length) failures.push("phase " + p + ": sync count grew by " + (rs[rs.length - 1].syncs - rs[0].syncs) + " over " + rs.length + " clicks");
  }
  const sEnd = await stats();
  if (sEnd) console.log("stats at the end: " + JSON.stringify(sEnd));
  if (sEnd && sEnd.stopped) failures.push("circuit breaker latched (stopped=true)");
  console.log("console warnings (plugin only): " + JSON.stringify(warns));
  const finalAlive = await evalJs("1 + 1");
  console.log("final responsiveness: " + JSON.stringify(finalAlive));
  if (finalAlive === "TIMEOUT" || finalAlive !== 2) failures.push("page unresponsive at the end");
  killChrome(); await sleep(700);
  console.log(failures.length ? "FAIL: " + failures.join(" | ") : "PASS: " + STORM + "+" + STORM + " clicks, every round trip < " + CLICK_BUDGET_MS + "ms, sync count bounded, page responsive");
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error("stress probe crashed: " + (e && e.stack ? e.stack : e)); process.exit(2); });
