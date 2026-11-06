#!/usr/bin/env node
/**
 * chip_state_probe — the regression check that DSH's *session-header subagent chip* keeps the
 * contract dsh-cursor-modes' chip copy depends on.
 *
 * The tweak reads the chip button's aria-label to decide the visible wording:
 *   aria "N 个子智能体，正在运行" -> visible "N 个子智能体正在运行" (1 -> "一个子智能体正在运行")
 *   aria "N 个子智能体"           -> visible "累计 N 个子智能体"
 * If DSH re-words that aria-label (or stops rendering a chip) this probe turns red instead of the
 * chip silently falling back to the 累计 wording. (Moved here from dsh-colombia-skin 0.2.3 with the tweak itself.)
 *
 * Attach-only on purpose: point it at an instance that already runs dsh-cursor-modes.
 *   PowerShell:  $env:DSH_ATTACH='3080'; node tools/chip_state_probe.cjs 3091
 * Exit 0 = PASS (contract holds on a live chip), 1 = FAIL, 2 = could not attach / no chip found.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ATTACH = process.env.DSH_ATTACH || "";
if (!ATTACH) {
  console.error("chip_state_probe: attach-only — set DSH_ATTACH=<port> (e.g. 3080) and re-run.");
  process.exit(2);
}
const CDP = Number(process.argv[2] || 3091) + 6000;
const TOKEN_FILE = process.env.DSH_TOKEN_FILE || path.join(os.homedir(), ".dsh", "launch-token.json");
const CHROME = process.env.DSH_CHROME ||
  ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
   "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHIP_JS = `(() => {
  const cands = [...document.querySelectorAll("button[aria-label]")].concat([...document.querySelectorAll("[class*=ZKlsPq_root] button")]);
  for (const b of cands) {
    const aria = (b.getAttribute("aria-label") || "").trim();
    const m = /^(\\d+)\\s*个子智能体(，正在运行)?$/.exec(aria);
    if (!m) continue;
    const visible = (b.innerText || "").trim();
    let want;
    if (m[2]) want = m[1] + " 个子智能体正在运行";   // Arabic digits, count straight from the aria
    else want = "累计 " + m[1] + " 个子智能体";
    return JSON.stringify({ aria, visible, want, running: !!m[2], ok: visible === want });
  }
  return JSON.stringify({ chip: null });
})()`;

(async () => {
  const j = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  const token = j.token;
  const port = Number(ATTACH);
  const prof = path.join(os.tmpdir(), "dsh-chipprobe-" + CDP + "-" + process.pid);
  try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }); } catch {}
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--window-size=1440,900", "--remote-debugging-port=" + CDP, "--user-data-dir=" + prof, "about:blank"],
    { stdio: "ignore", windowsHide: true });
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    await sleep(200);
    try {
      const list = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
      const page = list.find((x) => x.type === "page");
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
  }
  if (!ws) { console.error("chip_state_probe: no CDP endpoint"); chrome.kill(); process.exit(2); }
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
  };
  await new Promise((r) => (ws.onopen = r));
  for (const d of ["Page.enable", "Runtime.enable"]) await send(d);
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return "EXC " + JSON.stringify(r.exceptionDetails).slice(0, 160);
    return r && r.result ? r.result.value : undefined;
  };
  console.log("attach mode: driving the running instance on " + port);
  await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/?token=" + token });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await evalJs("/选择工作区/.test(document.body.innerText||'')")) break;
  }
  await evalJs("(() => { const rows = [...document.querySelectorAll('button,[role=button],[class*=Row]')]; const w = rows.find((n) => /工作区1-cursor/.test(n.innerText || '')); if (w) w.click(); })()");
  await sleep(3500);
  const names = JSON.parse(await evalJs("JSON.stringify([...document.querySelectorAll('[class*=sessionRow]')].slice(0, 5).map((n) => (n.innerText || '').split(String.fromCharCode(10))[0].trim()).filter(Boolean))") || "[]");
  let found = null;
  // click session rows BY INDEX: matching on their innerText is brittle (a row carries a status
  // prefix and a relative time, and its whitespace shifts), which silently clicked nothing.
  const order = [];
  for (const k of [1, 2, 3]) order.push(k);
  for (const index of order) {
    await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/?token=" + token });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(500);
      ready = (await evalJs("document.querySelectorAll('[class*=sessionRow]').length")) > index;
    }
    await sleep(1500);
    const label = await evalJs("(() => { const rows = [...document.querySelectorAll('[class*=sessionRow]')]; const n = rows[" + index + "]; if (!n) return null; const t = (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 26); n.click(); return t; })()");
    if (label === null) { console.log("no session row at index " + index); continue; }
    console.log("session[" + index + "] = " + JSON.stringify(label));
    let got = null;
    for (let k = 0; k < 8 && got === null; k++) {
      await sleep(3000);
      // a click landing before the app is interactive opens nothing, so click again halfway through
      if (k === 3) await evalJs("(() => { const rows = [...document.querySelectorAll('[class*=sessionRow]')]; const n = rows[" + index + "]; if (n) n.click(); })()");
      const probe = JSON.parse(await evalJs(CHIP_JS));
      if (probe && probe.aria) got = probe;
    }
    if (got !== null) { found = Object.assign({ session: label }, got); break; }
    console.log("no chip in session[" + index + "] — trying the next one");
  }
  chrome.kill();
  if (!found) {
    console.error('FAIL: no subagent chip (button[aria-label] = "N 个子智能体[，正在运行]") in ' + names.length + " session(s) — contract unverifiable");
    process.exit(2);
  }
  console.log("session     : " + found.session);
  console.log("chip aria   : " + JSON.stringify(found.aria) + " (running=" + found.running + ")");
  console.log("chip visible: " + JSON.stringify(found.visible));
  console.log("chip want   : " + JSON.stringify(found.want));
  if (!found.ok) {
    console.error("FAIL: chip_state_probe — DSH's aria wording and the plugin's visible text disagree");
    process.exit(1);
  }
  console.log("PASS: chip_state_probe — aria wording -> visible text contract holds");
  process.exit(0);
})();
