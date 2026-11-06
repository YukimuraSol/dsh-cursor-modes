// Regression check for the colour tokens the skin's chrome overrides.
//
// 1. Floating menus/popovers paint a translucent skin tint instead of the theme's
//    solid --dsw-specific-menu (== --dsw-alias-bg-layer-3).
// 2. Sticky menu group headers stay near-opaque so rows can't show through them.
// 3. The dim label roles (secondary/tertiary — trace rows, tool names, summaries,
//    timestamps) are lifted above the palette's own values so they stay legible on
//    the wallpaper; body copy (label-primary) is untouched.
//
// Boots a throwaway DSH + headless Chrome, opens the "/" palette (one of the
// surfaces reading the menu token) and measures computed colours. No screenshots.
//
// Moved here from dsh-colombia-skin 0.2.3 with the chip-copy tweak: the copy cases below
// exercise dsh-cursor-modes' rewrite now, while the token cases still need the skin installed
// on the attached instance.
//
// usage: node tools/chrome_token_probe.cjs [port]
//   port defaults to 3090 — never point it at your own running dsh web.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.argv[2] || 3090);
const CDP = PORT + 6000;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DSH_BIN = process.env.DSH_BIN ||
  "D:\\OpenCode\\cache\\npm\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
// The moon skin's palette values before the label lift (catalog in lib/client.js).
const BASELINE = { secondary: "#a8bddc", tertiary: "#7e95b8" };
// DSH_ATTACH=<port>: drive the instance already listening on that port instead of spawning our own.
// A spawned instance resolves the skin from whatever profile the CLI picks up — on this machine that
// is the frozen copy under D:\dsh-fallback\plugins, not this repo — so the assertions would test the
// wrong skin. Attach to the live instance with DSH_ATTACH=<instance port>; argv[2] then only picks
// the CDP port (argv[2] + 6000) and the chrome profile dir, so several attach probes can run at once.
const ATTACH = Number(process.env.DSH_ATTACH || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let url = null;
  let dsh = null;
  if (ATTACH) {
    const tok = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dsh", "launch-token.json"), "utf8"));
    url = `http://127.0.0.1:${tok.port || ATTACH}/?token=${tok.token}`;
    console.error(`attach mode: driving the running instance on ${tok.port || ATTACH}`);
  } else {
    for (const [file, what] of [[CHROME, "chrome"], [DSH_BIN, "dsh bin"]]) {
      if (!fs.existsSync(file)) {
        console.error(`missing ${what}: ${file} (set DSH_BIN to override)`);
        process.exit(2);
      }
    }
    const t0 = Date.now();
    const log = path.join(os.tmpdir(), `dsh-chrome-token-${PORT}.log`);
    dsh = spawn(process.execPath, [DSH_BIN, "web", "--no-open", "--port", String(PORT)], {
      cwd: os.homedir(), windowsHide: true,
      stdio: ["ignore", fs.openSync(log, "w"), fs.openSync(log + ".err", "w")]
    });
    while (Date.now() - t0 < 90000) {
      await sleep(200);
      const m = fs.readFileSync(log, "utf8").match(new RegExp(`http://127\\.0\\.0\\.1:${PORT}/\\?token=\\S+`));
      if (m) { url = m[0].trim(); break; }
    }
    if (!url) { console.error("dsh never printed a token URL; see " + log); dsh.kill(); process.exit(1); }
  }

  const prof = path.join(os.tmpdir(), `dsh-chrome-token-prof-${PORT}`);
  fs.rmSync(prof, { recursive: true, force: true });
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--window-size=1440,900", "--remote-debugging-port=" + CDP, "--user-data-dir=" + prof, "about:blank"],
    { stdio: "ignore", windowsHide: true });
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    await sleep(200);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {}
  }
  if (!ws) { console.error("chrome devtools never came up"); chrome.kill(); if (dsh) dsh.kill(); process.exit(1); }

  let id = 0;
  const pending = new Map();
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id); } };
  await new Promise((r) => (ws.onopen = r));
  for (const d of ["Page.enable", "Runtime.enable"]) await send(d);
  await send("Page.navigate", { url });
  const evalJs = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }))?.result?.value;

  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    await sleep(200);
    ready = (await evalJs(`document.querySelector('[data-composer-input]') !== null`)) === true;
  }
  if (!ready) { console.error("composer never appeared"); chrome.kill(); if (dsh) dsh.kill(); process.exit(1); }

  // execCommand drives Lexical's beforeinput; the key-event pair is the fallback.
  await evalJs(`(() => { const el = document.querySelector('[data-composer-input]'); el.focus();
    document.execCommand('insertText', false, '/'); return true; })()`);
  await sleep(1200);
  if (!/cursor-plan/.test(await evalJs(`document.body.innerText`))) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191,
      key: "/", code: "Slash", text: "/", unmodifiedText: "/", modifiers: 0 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191,
      key: "/", code: "Slash" });
    await sleep(1300);
  }
  const paletteOpen = /cursor-plan/.test(await evalJs(`document.body.innerText`));

  const probe = await evalJs(`(() => {
    const cs = getComputedStyle(document.body);
    const norm = (v) => v.replace(/\\s/g, '').toLowerCase();
    const read = (n) => cs.getPropertyValue(n).trim();
    const menu = read('--dsw-specific-menu');
    const surfaces = [...document.querySelectorAll('*')]
      .filter((n) => norm(getComputedStyle(n).backgroundColor) === norm(menu))
      .map((n) => String(n.className).slice(0, 40))
      .filter(Boolean);
    const titles = [...document.querySelectorAll('[class*="_groupTitle"]')].map((n) => getComputedStyle(n).backgroundColor);
    const tert = read('--dsw-alias-label-tertiary');
    const sec = read('--dsw-alias-label-secondary');
    // elements actually painting those colours right now
    let paintedTert = 0, paintedSec = 0;
    for (const n of document.querySelectorAll('*')) {
      if (n.children.length) continue;
      if (!(n.textContent || '').trim()) continue;
      const c = norm(getComputedStyle(n).color);
      if (c === norm(tert)) paintedTert += 1;
      if (c === norm(sec)) paintedSec += 1;
    }
    return JSON.stringify({
      menu, surfaces: surfaces.slice(0, 5), titles: titles.slice(0, 4),
      declared: { menu: read('--columbina-menu'), tertiary: read('--columbina-label-tertiary'), secondary: read('--columbina-label-secondary') },
      role: { tertiary: tert, secondary: sec }, painted: { tertiary: paintedTert, secondary: paintedSec }
    });
  })()`);
  const r = JSON.parse(probe);

  // Session-header meta triggers only mount while subagents/jobs run, so stand in for
  // them: the class names come from dsh-client-ui-subagent / -jobs, and this asserts the
  // chrome rule paints them at the secondary (hover) role instead of tertiary.
  const triggerProbe = await evalJs(`(() => {
    const secondary = getComputedStyle(document.body).getPropertyValue('--columbina-label-secondary').trim();
    const out = [];
    for (const cls of ['ZKlsPq_trigger', 'QsffPG_trigger']) {
      const el = document.createElement('span');
      el.className = cls;
      el.textContent = 'x';
      document.body.appendChild(el);
      out.push({ cls, color: getComputedStyle(el).color });
      el.remove();
    }
    return JSON.stringify({ secondary, triggers: out });
  })()`);
  const t = JSON.parse(triggerProbe);

  // The composer dock strips (queued/steer rows, todo panel, goal bar) mount only while
  // something is queued, so stand in for them with their class names: dsh-client-ui-conversation
  // (QueueDock._7yHdaG_panel, TodoPanel.lXshSW_root) and dsh-client-ui-goal (.nLMEza_bar).
  // 0.1.7 changed what they paint: those packages now declare
  // `background:var(--dsw-specific-menu); backdrop-filter:var(--dsw-menu-backdrop-filter)`
  // (the queue dock and goal bar inside descendant selectors, which is why a naked node only
  // shows it for the bare-class .lXshSW_root), and --dsw-specific-tip is left referenced by
  // dsh-client-ui-theme alone — a dead token. So these strips eat the skin's MENU glass now,
  // not the thinner input glass, and what is worth asserting is that layer plus "none of them
  // turned into a solid slab". Measured on the live instance meanwhile: 0 rendered instances of
  // the three classes across five sessions, so no live visual can be checked here at all.
  const dockProbe = await evalJs(`(() => {
    const cs = getComputedStyle(document.body);
    const layer = { menu: cs.getPropertyValue('--dsw-specific-menu').trim(),
      skinMenu: cs.getPropertyValue('--columbina-menu').trim(),
      menuBackdrop: cs.getPropertyValue('--dsw-menu-backdrop-filter').trim() };
    const docks = [];
    for (const cls of ['_7yHdaG_panel', 'lXshSW_root', 'nLMEza_bar']) {
      const el = document.createElement('div');
      el.className = cls;
      document.body.appendChild(el);
      const s = getComputedStyle(el);
      docks.push({ cls, bg: s.backgroundColor, backdrop: s.backdropFilter });
      el.remove();
    }
    return JSON.stringify({ layer, docks });
  })()`);
  const d = JSON.parse(dockProbe);

  // Settings controls, the session-list hover preview and the changes card paint either native
  // neutrals (#353638 / #43454A / #FFFFFF14) or a component-local variable that a body-level
  // token cannot reach, so stand in the real nodes (the classes the packages ship) and read the
  // cascade back. Sources: dsh-client-ui-theme _8HJdBW_selected, dsh-client-ui-settings-plugin-
  // inventory qSYN7G_groupTitleRow, dsh-client-ui-primitives HoverCard (hashed into the web
  // frontend bundle as _card_178vx_13), dsh-client-ui-deliverables hz8-rW_card/_header.
  const surfaceProbe = await evalJs(`(() => {
    const cs = getComputedStyle(document.body);
    const read = (n) => cs.getPropertyValue(n).trim();
    const mk = (cls, parent) => { const el = document.createElement('div'); el.className = cls; (parent || document.body).appendChild(el); return el; };
    const want = { input: read('--columbina-input'), select: read('--columbina-select'), selectHover: read('--columbina-select-hover'), menu: read('--columbina-menu'), line: read('--columbina-line') };
    const got = {
      modulePlatform: read('--dsw-alias-bg-module-platform'),
      navActive: read('--dsw-specific-sidebar-nav-item-active'),
      navHover: read('--dsw-specific-sidebar-nav-item-hover'),
      interactiveHover: read('--dsw-alias-interactive-bg-hover')
    };
    const card = mk('_card_178vx_13');
    card.setAttribute('style', '--dsh-hover-preview-fade: 100ms');
    const ccs = getComputedStyle(card);
    const hoverCard = { bg: ccs.backgroundColor, varValue: ccs.getPropertyValue('--dsw-hovercard-bg').trim(), backdrop: ccs.backdropFilter };
    card.remove();
    const changes = mk('hz8-rW_card');
    const header = mk('hz8-rW_header', changes);
    const changesOut = { cardBg: getComputedStyle(changes).backgroundColor, headerBg: getComputedStyle(header).backgroundColor,
      fill: getComputedStyle(changes).getPropertyValue('--changes-fill').trim() };
    changes.remove();
    const group = mk('qSYN7G_groupTitleRow');
    const groupRow = { bg: getComputedStyle(group).backgroundColor };
    group.remove();
    const cube = mk('_8HJdBW_selected');
    const cubeOut = { border: getComputedStyle(cube).borderTopColor };
    cube.remove();
    return JSON.stringify({ want, got, hoverCard, changes: changesOut, groupRow, cube: cubeOut });
  })()`);
  const sp = JSON.parse(surfaceProbe);

  // The injected copy tweak must rewrite the subagent counter wording as it mounts (and on
  // re-render): running -> "N 个子智能体正在运行" (1 -> "一个…"), idle -> "累计 N 个子智能体".
  // The 累计 case is asserted on its own below, because what the user asked for is that the
  // literal characters 累计 are rendered, not just that the digit moved.
  // The chip cases mirror the real DOM: 0.1.7 renders the TOTAL as the chip's visible text in
  // every state and announces a running subagent through the chip button's aria-label, so the
  // tweak has to promote the visible text from 累计… to …正在运行 when that aria flips.
  const copyProbe = await evalJs(`(async () => {
    const cases = [
      ['1 个子智能体，正在运行', '1 个子智能体正在运行'],
      ['3 个子智能体，正在运行', '3 个子智能体正在运行'],
      ['5 个子智能体', '累计 5 个子智能体'],
      ['12 个子智能体', '累计 12 个子智能体']
    ];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    for (const [input, want] of cases) {
      const el = document.createElement('div');
      el.textContent = input;
      document.body.appendChild(el);
      await wait(80);
      out.push({ input, got: el.textContent, want, ok: el.textContent === want });
      el.remove();
    }
    const mkChip = (aria, text) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', aria);
      const s = document.createElement('span');
      s.textContent = text;
      b.appendChild(s);
      document.body.appendChild(b);
      return { b, s };
    };
    // the shape the user reported: 6 known subagents, 1 of them running -> aria says 1, visible says 6
    const mixed = mkChip('1 个子智能体，正在运行', '6 个子智能体');
    await wait(140);
    const running = mixed.s.textContent;
    mixed.b.setAttribute('aria-label', '6 个子智能体');      // run ends: aria flips back to the total
    await wait(140);
    const idle = mixed.s.textContent;
    const one = mkChip('1 个子智能体，正在运行', '2 个子智能体');
    await wait(140);
    const single = one.s.textContent;
    const foreign = mkChip('sidebar 提示', '3 个子智能体');    // not a subagent chip -> idle wording only
    await wait(140);
    const foreignGot = foreign.s.textContent;
    [mixed.b, one.b, foreign.b].forEach((n) => n.remove());
    return JSON.stringify({ cases: out, chip: { running, idle, single, foreign: foreignGot } });
  })()`);
  const cp = JSON.parse(copyProbe);
  const cpCases = cp.cases;
  const cpChip = cp.chip;
  console.log(`palette_open=${paletteOpen}`);
  console.log(`menu token   : ${r.menu}   (declared ${r.declared.menu})`);
  console.log(`surfaces     : ${JSON.stringify(r.surfaces)}`);
  console.log(`group titles : ${JSON.stringify(r.titles)}`);
  console.log(`label roles  : secondary ${r.role.secondary} (declared ${r.declared.secondary}), tertiary ${r.role.tertiary} (declared ${r.declared.tertiary})`);
  console.log(`painted now  : secondary x${r.painted.secondary}, tertiary x${r.painted.tertiary}`);
  for (const tr of t.triggers) console.log(`trigger      : .${tr.cls} → ${tr.color} (want ${t.secondary})`);
  console.log(`dock layer   : --dsw-specific-menu ${d.layer.menu} (skin --columbina-menu ${d.layer.skinMenu}), backdrop ${d.layer.menuBackdrop}`);
  for (const dk of d.docks) console.log(`dock strip   : .${dk.cls} → ${dk.bg} backdrop ${dk.backdrop}`);
  for (const c of cpCases) console.log(`copy tweak   : "${c.input}" → "${c.got}" (want "${c.want}")`);
  console.log(`copy chip    : aria(running 1, visible 6) → "${cpChip.running}" (want "1 个子智能体正在运行"); then aria(total 6) → "${cpChip.idle}" (want "累计 6 个子智能体")`);
  console.log(`copy chip    : aria(running 1, visible 2) → "${cpChip.single}" (want "1 个子智能体正在运行"); foreign button aria → "${cpChip.foreign}" (want "累计 3 个子智能体")`);

  chrome.kill();
  if (dsh) dsh.kill();
  await sleep(1000);
  try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch {}

  // colour + luminance helpers (rough sRGB weighting is enough to compare roles)
  const toRgb = (v) => {
    if (/^#/.test(v)) {
      const h = v.length === 4 ? v.slice(1).split("").map((c) => c + c).join("") : v.slice(1);
      return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    }
    return (v.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
  };
  const lum = (v) => { const [a, b, c] = toRgb(v); return 0.2126 * a + 0.7152 * b + 0.0722 * c; };
  const same = (a, b) => toRgb(a).join() === toRgb(b).join();

  const menuTranslucent = /,\s*0?\.\d+\s*\)$/.test(r.menu);
  const menuPainted = r.surfaces.length > 0;
  const titlesOpaque = r.titles.every((bg) => !/,\s*0?\.86\s*\)$/.test(bg));
  const roleWiring = same(r.role.tertiary, r.declared.tertiary) && same(r.role.secondary, r.declared.secondary);
  const lifted = lum(r.role.tertiary) > lum(BASELINE.tertiary) && lum(r.role.secondary) > lum(BASELINE.secondary);
  const triggersAtHoverRole = t.triggers.every((x) => same(x.color, t.secondary));
  const norm = (v) => v.replace(/\s/g, "").toLowerCase();
  const alphaOf = (v) => { const m = String(v).match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1].split(",").map(Number); return p.length > 3 ? p[3] : 1; };
  // 0.1.7: the strips eat --dsw-specific-menu (menu glass + blur backdrop) instead of the now
  // dead --dsw-specific-tip, and no current session renders them (5 checked) — so the honest
  // assertion is the layer they eat plus "no strip became opaque".
  const dockStripsMenuGlass = norm(d.layer.menu) === norm(d.layer.skinMenu) && /,\s*0?\.\d+\s*\)$/.test(d.layer.menu)
    && /blur/.test(d.layer.menuBackdrop) && d.docks.every((x) => alphaOf(x.bg) < 1);
  const copyTweaked = cpCases.every((x) => x.ok);
  // hard requirement from the user: the idle chip must literally show 累计
  const copyIdleShowsAccum = cpCases.filter((x) => /^\d+ 个子智能体$/.test(x.input))
    .every((x) => x.got.includes("累计") && x.ok);
  // While the chip announces a running subagent the visible text must switch to …正在运行 and must
  // drop the 累计 prefix; when the run ends it must come back to 累计. 1 stays 一个…
  // the count must come from the aria (running count), the digits must stay Arabic (no 一个/一),
  // and the 累计 prefix must be gone while something runs
  const copyChipRunning = cpChip.running === "1 个子智能体正在运行" && !cpChip.running.includes("累计")
    && !cpChip.running.includes("一") && cpChip.single === "1 个子智能体正在运行";
  const copyChipIdle = cpChip.idle === "累计 6 个子智能体" && cpChip.foreign === "累计 3 个子智能体";
  const transl = (v) => /,\s*0?\.\d+\s*\)$/.test(v);
  const modPlatformGlass = norm(sp.got.modulePlatform) === norm(sp.want.input) && transl(sp.want.input);
  const navActiveHued = norm(sp.got.navActive) === norm(sp.want.select) && transl(sp.want.select);
  const navHoverHued = norm(sp.got.navHover) === norm(sp.want.selectHover) && transl(sp.want.selectHover);
  const interactiveHoverHued = norm(sp.got.interactiveHover) === norm(sp.want.selectHover);
  const hoverCardGlass = norm(sp.hoverCard.bg) === norm(sp.hoverCard.varValue) && norm(sp.hoverCard.varValue) === norm(sp.want.menu)
    && transl(sp.want.menu) && sp.hoverCard.backdrop !== "none";
  const changesCardGlass = norm(sp.changes.headerBg) === norm(sp.want.input) && norm(sp.changes.fill) === norm(sp.want.input);
  const settingsGroupRowClear = norm(sp.groupRow.bg) === "rgba(0,0,0,0)";
  const themeCubeSkinLine = norm(sp.cube.border) === norm(sp.want.line);

  console.log(`checks: menu_translucent=${menuTranslucent} menu_painted=${menuPainted} titles_occlude=${titlesOpaque} ` +
    `label_wired=${roleWiring} label_lifted=${lifted} (tertiary ${Math.round(lum(r.role.tertiary))} > ${Math.round(lum(BASELINE.tertiary))}, ` +
    `secondary ${Math.round(lum(r.role.secondary))} > ${Math.round(lum(BASELINE.secondary))}) triggers_at_hover_role=${triggersAtHoverRole} ` +
    `dock_strips_menu_glass=${dockStripsMenuGlass} copy_tweaked=${copyTweaked} copy_idle_shows_accum=${copyIdleShowsAccum} ` +
    `copy_chip_running=${copyChipRunning} copy_chip_idle=${copyChipIdle}`);
  // info only: the home screen mounts no trace rows, so nothing paints these roles yet.
  // What matters is the wiring above — the trace rows (dsh-client-ui-chat
  // _reasoning/_details, conversation _summary) declare color:var(--dsw-alias-label-tertiary).
  console.log(`info: elements painting those roles right now = ${r.painted.tertiary + r.painted.secondary}`);
  for (const [k, v] of Object.entries(sp.got)) console.log(`surface token: ${k} → ${v} (want ${k === "modulePlatform" ? sp.want.input : sp.want.selectHover})`);
  console.log(`hover preview: bg ${sp.hoverCard.bg} / --dsw-hovercard-bg ${sp.hoverCard.varValue} (want ${sp.want.menu}), backdrop ${sp.hoverCard.backdrop}`);
  console.log(`changes card : header ${sp.changes.headerBg}, --changes-fill ${sp.changes.fill} (want ${sp.want.input})`);
  console.log(`settings     : groupTitleRow bg ${sp.groupRow.bg} (want transparent), 外观 cube border ${sp.cube.border} (want ${sp.want.line})`);
  console.log(`checks2: module_platform_glass=${modPlatformGlass} nav_active_hued=${navActiveHued} nav_hover_hued=${navHoverHued} interactive_hover_hued=${interactiveHoverHued} ` +
    `hover_preview_glass=${hoverCardGlass} changes_card_glass=${changesCardGlass} settings_group_row_clear=${settingsGroupRowClear} theme_cube_line=${themeCubeSkinLine}`);
  const ok = menuTranslucent && menuPainted && titlesOpaque && roleWiring && lifted && triggersAtHoverRole && dockStripsMenuGlass && copyTweaked && copyIdleShowsAccum
    && copyChipRunning && copyChipIdle
    && modPlatformGlass && navActiveHued && navHoverHued && interactiveHoverHued && hoverCardGlass && changesCardGlass
    && settingsGroupRowClear && themeCubeSkinLine;
  console.log(ok ? "PASS: chrome overrides resolve as intended" : "FAIL");
  process.exit(ok ? 0 : 1);
})();
