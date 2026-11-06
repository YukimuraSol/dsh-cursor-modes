# dsh-cursor-modes 桌面端（Electron）回归报告

- 执行时间：2026-10-30 17:16 ~ 17:26（Asia/Shanghai）
- 实例：DeepSeek Harness 桌面端（Electron，宿主 release 0.2.1-rc.3，Electron 44.7.0 / Chrome 152.0.7977.130）
- 插件版本：**0.2.10**（`C:\Users\ASUS\.dsh\profiles\desktop\node_modules\dsh-cursor-modes\package.json` → version 0.2.10）
- 模型：**ofm / codearts/deepseek-v4.1-flash**（`http://127.0.0.1:18900/v1`）
- 执行方式：CDP（`--remote-debugging-port=9222`，单 page target `dsh-app://app/`）驱动真界面 + 会话日志（zstd jsonl 解帧）+ 桥接路由直调
- 只记录，不改插件源码；未触碰 3080 / 4000 / 3500 实例；窗口全程最小化在屏幕外坐标 (-21333,-21333)，未 `Page.bringToFront`

## 一、结论摘要

| 项 | 值 |
| --- | --- |
| 本轮跑到的条目 | **14**（CM-G 9 条 + CM-C 5 条） |
| PASS | **10** |
| FAIL | **0** |
| PARTIAL | **1**（G-08） |
| BLOCKED | **3**（G-05 / G-07 / G-09） |

**本轮最重要的一条：0.2.7 期「计划卡片拿不到计划文件路径」那个根因已经修好。**

0.2.7 时 C-06 / C-08 / C-09 / C-11 / C-12 五条是同一个根因（`matched.resultText` 为空 → `file=""`）连坐 FAIL；0.2.10 上这五条**全部 PASS**，逐条实测值见第三节。

**G-01 也翻绿了**：设置 → 内置插件 下出现了「Cursor Plan 委派门禁」标签页（0.2.7 期该标签页不存在，导致 G-02~G-06、G-09 全部无从验证）。

## 二、环境核实

| 项 | 实测 |
| --- | --- |
| 启动命令 | `Start-Process -FilePath '<安装目录>\DeepSeek Harness.exe' -WorkingDirectory 'C:\' -ArgumentList '--remote-debugging-port=9222','--enable-logging'` |
| 工作目录 | 必须显式给 `C:\`。会话 cwd 是中文路径时 `Start-Process` 会报「系统找不到指定的文件」 |
| DSH_HOME | `C:\Users\ASUS\.dsh`；宿主实际 profile = `C:\Users\ASUS\.dsh\profiles\desktop` |
| 安装目录 | `C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness`（名字里**有空格**，注册表 `InstallLocation` 写的是无空格版本，是错的） |
| 9222 | 监听 `127.0.0.1:9222`，pid 11268；`/json/version` 返回 `Chrome/152.0.7977.130`、UA 含 `@deepseek-ai/dsh-desktop/0.2.1-rc.3` |
| 应用内 Web UI | `http://127.0.0.1:64390`（只绑 127.0.0.1，见 G-08） |
| 模型连通 | `request/header` 实测 `{"provider":"ofm","model":"codearts/deepseek-v4.1-flash"}`；turn 1 用时 **70.0 秒**（09:16:15.383Z → 09:17:25.424Z），usage `input 966 / output 36 / total 15338 / cacheRead 14336` |
| 闸门配置 | `profiles\desktop\cordis.patch.yml` 的 `cursor-modes` 条目只有 `gate: {backend: llm, timeoutMs: 2500}`；`enabled` 未写 → describe/status 都报 `enabled: false` |

## 三、逐条结果

判定口径按清单第 4 节：只对上一部分写 PARTIAL；跑不动写 BLOCKED 并注明原因；「实测值」一律写观察到的原文/数值。

### CM-G 设置与委派闸门（9 条：5 PASS / 1 PARTIAL / 3 BLOCKED）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| G-01 | **PASS** | 设置 → 内置插件：`[role=dialog] [role=tab]` 共 **2** 个 —— `插件列表`(selected) 与 **`Cursor Plan 委派门禁`**；点开后 `[role=tabpanel]` 出现 `id=":r2h:-panel-cursor-modes"`、`hidden=false`、文本 135 字。面板正文逐字：「委派门禁 / 打开后，计划模式下的 subagent / send_message 委派、以及需要你点确认的操作，都先交给判官判定；判官拿不准再问你。改动即时生效。/ 判官来源 / 跟随当前模型 / JEV 专用判官 / 判官模型 / 跟随当前会话模型 / 高级设置 / 超时 2500 ms ▸」。顶部有一个 `button[role=switch]`，`aria-checked="false"` |
| G-02 | **PASS** | `POST /api/dsh-cursor-modes/settings/describe` → 200 `{ok:true,value:{ns:"cursor-modes",values:{…},defaults:{…},apiKeyConfigured:false,credential:{ref:"OPENROUTER_API_KEY",configured:true}}}`；values 与 defaults 各 **8** 个键：`allowConfidence, apiKeyRef, backend, baseUrl, enabled, model, timeoutMs, workReject`，**没有 apiKey**。`backend:"llm"`、`timeoutMs:2500`、`allowConfidence:0.8`、`workReject:0.2`、`baseUrl:"http://127.0.0.1:7899/api/v1"`、`apiKeyRef:"OPENROUTER_API_KEY"`。注：`apiKeyConfigured:false` 与 `credential.configured:true` 并存 —— 前者指插件自己存的 gate 密钥，后者指 credential store 里有这个 ref，两者不同源，不是矛盾 |
| G-03 | **PASS** | `mutate {patch:{timeoutMs:3000}}` → 200 `{ok:true,value:{…,timeoutMs:3000},apiKeyConfigured:false,credential:{…}}`；紧接着 describe 仍是 `backend:"llm", model:"", baseUrl:"http://127.0.0.1:7899/api/v1", allowConfidence:0.8, workReject:0.2, apiKeyRef:"OPENROUTER_API_KEY", enabled:false` —— **合并而非替换**，另外 7 个字段一个没掉；`POST /settings/status` 的 `effectiveTimeoutMs` 由 2500 变 **3000**（不重启不刷新）。测完已 mutate 回 2500 |
| G-04 | **PASS** | 5 条非法 patch 全部 `{ok:false, code:"settings-rejected"}`（HTTP 200，不是 500），message 逐条点名：`gate \`baseUrl\` must be an absolute http(s) URL`（ftp://x/v1）、同上（127.0.0.1:7899/api/v1 无 scheme）、`gate \`timeoutMs\` must be a positive integer`（0）、`gate \`allowConfidence\` must be a number in [0, 1]`（1.5）、`gate has unknown key(s) foo`。之后 describe 的 timeoutMs 仍是 2500，**没有任何一项被写进配置** |
| G-05 | **BLOCKED** | `lastVerdict` 全程为 `null`。触发它需要在 plan 模式下真的发生一次 subagent / send_message 委派判定，且闸门 `enabled` 得是 true（当前 false，`delegationBlock` 直接短路，不会产生 verdict）。本轮的 C 类只跑了 create_plan + Build，没有委派回合 |
| G-06 | **PASS** | 对照同一张卡片的两个分支：**跟随当前模型（llm）** 下「高级设置」只渲染 1 项 —— `判官超时（毫秒）`，`input[type=number]` value `2500`，说明「超过就按拦截处理」；`放行置信度`/`改动概率上限` **不渲染**（jevOnly 过滤生效）。切到 **JEV 专用判官** 后「高级设置」正好 3 项：超时 2500、放行置信度 0.8、改动概率上限 0.2（折叠标题变成 `超时 2500 ms · 放行阈值 0.8 · 改动上限 0.2`），并出现「连接」组 3 项：`模型 ID`（placeholder `jev-latest`）、`API 地址`（value `http://127.0.0.1:7899/api/v1`）、`密钥`（`input[type=password]`，value 回显空，旁边一个「显示」按钮）。密钥 placeholder 实测是 `粘贴密钥` 而非清单写的「已保存，留空不改」——因为本次 `apiKeyConfigured:false`（没存过密钥），文案分支正确 |
| G-07 | **BLOCKED** | 要构造「profile 里没有 cursor-modes 条目」的实例才能看到 `settings-unavailable`。本机三个实例（3080/4000/3500）都在硬约束禁止触碰范围，另起新实例超出本轮范围。**间接证据**：把 plan-state 指向 `C:\Windows\win.ini` → 400 `{ok:false,code:"invalid-plan-path",message:"path must be a plan file under C:\\Users\\ASUS\\.dsh\\plans"}`；未知路由 `POST /api/dsh-cursor-modes/__nope__` → 404 `not found` —— 都是可诊断的 JSON，不是连接错误 |
| G-08 | **PARTIAL** | **405 那一半成立**：对 6 条路由 × GET/PUT/DELETE 共 18 次，全部 405 且 message 带实际方法名。两族文案不同 —— settings 族回 `{"error":"method not allowed: GET"}`；switch/build/plan-state 族回 `{"ok":false,"code":"method-not-allowed","message":"method not allowed: GET"}`。`plan-state` 的 GET 是合法方法，越界路径回 400 `invalid-plan-path`（见 G-07）。**403 loopback-only 那一半没验**：应用内 Web UI 只绑 `127.0.0.1:64390`（`Get-NetTCPConnection` 实测 LocalAddress=127.0.0.1），本机任何网卡地址都连不进来，构造不出「非 loopback 来源」 |
| G-09 | **BLOCKED** | 需要「关掉开关 → plan 模式下让模型 subagent 一个实现类任务 → 不再被拦 → 再打开 → 又被拦」。当前 `enabled:false` 且本轮没跑 plan 下的委派回合，没有可观察的 delegationBlock 返回值。注：G-03 已经从侧面证明 mutate 改配置**不重启即生效**（effectiveTimeoutMs 2500→3000 立刻反映在 status 上），但那只覆盖「配置读得到」，不覆盖「判定真的读了新值」 |

### CM-C 计划模式与计划卡片（本轮 5 条：5 PASS）

| 编号 | 结论 | 实测值 |
| --- | --- | --- |
| C-06 | **PASS** | 卡片 DOM：`div.Sc7pKm_checklist[data-plan-checklist="1"]`，头部 `<h2>执行清单</h2>` + `div.Sc7pKm_progress` 文本 **`1 / 3`**；3 条 `div[data-todo-status]`，值依次 `completed, pending, pending`；完成项 `div.Sc7pKm_todo.Sc7pKm_todoDone` 内有 `span.Sc7pKm_boxDone` 文本 `✓`，文字 span `Sc7pKm_todoTextDone` 的 `getComputedStyle().textDecorationLine = "line-through"`；两条 pending 的文字 span 是 `none`。本轮没有 in_progress 项，所以「进行中」标签未观察到 |
| C-08 | **PASS** | `div.Sc7pKm_actions` 里有 `button.Sc7pKm_link` 文本 **`View Plan`**（与 `展开全文` 并列）。说明 `file !== ""` 成立 —— 路径确实是从工具结果的 `Plan file: …` 抓到的（见 C-11 的 plan-state 一致性） |
| C-09 | **PASS** | 点 Build in Default 后本会话（`session-296e3f76-3c4c-4e99-a140-8d3d486e9865`）日志：**seq 32 `todo/write`** —— `{"todos":[{"content":"环境准备完成","status":"completed"},{"content":"执行构建检查","status":"pending"},{"content":"验证页面重载","status":"pending"}]}`，正好在 turn 2 的 `step/start`（seq 33）之前写出，**条目只有 content+status、没有 id**；**seq 34** user/message 正文以 `The user clicked "Build in Default".` 开头（`source.kind="cursor-plan", form="notice", summary="The user clicked \"Build in Default\"."`）；**seq 36** user/message 逐字 `Todo from the plan: [x] 环境准备完成 · [ ] 执行构建检查 · [ ] 验证页面重载. Use todo_write to update state.`，`source.kind="dsh-cursor-modes", form="notice", summary="Approved checklist"`。**全日志 summary=Approved checklist 的通知有且只有 1 条**。偏差一处：清单通知写的是**全部 3 条**（含已 completed 的），清单里写的「2 条」是按它们那份 2 条 pending 的样例推的，不是只写 pending |
| C-11 | **PASS** | 计划文件 `C:\Users\ASUS\.dsh\plans\计划卡片验证_ab406f3c.plan.md` frontmatter 点前无 `dispatched`，点后出现 `dispatched: '2026-10-30T09:17:26.702Z'` 与 `dispatchedChoice: default`，其余字段（name/overview/todos/isProject）与正文未变。`GET /api/dsh-cursor-modes/plan-state?path=<该文件>` → 200 `{"ok":true,"value":{"exists":true,"dispatched":true,"choice":"default","at":"2026-10-30T09:17:26.702Z","todos":[{"id":"env-ready",…},{"id":"build-check",…},{"id":"reload-check",…}]}}`。卡片右侧 `span[data-plan-dispatched="1"]` 文本 `Dispatched`，`textDecorationLine = "none"`、`cursor = "default"` |
| C-12 | **PASS** | 点完 Build 后卡片按钮只剩 `["展开全文","View Plan"]`；`Page.reload(ignoreCache:true)` 重新挂载后再次实测：`{checklist:true, todos:3, statuses:["completed","pending","pending"], progress:"1 / 3", buttons:["展开全文","View Plan"], view:true, dispatched:true}` —— **Build 按钮没有复活**，Dispatched 仍在，清单仍在。重复点击这一半：按钮已不存在，无可点目标；未再手工 POST /build 复测 |

## 四、与 0.2.7 报告的差异

| 项 | 0.2.7（2026-10-30 11:32~12:25） | 0.2.10（本次） |
| --- | --- | --- |
| G-01 设置页闸门标签页 | FAIL（`[role=tab]` 数量 0） | **PASS**（tab 出现，面板 id `-panel-cursor-modes`） |
| C-06 执行清单 | FAIL（无 `[data-plan-checklist]`） | **PASS**（`1 / 3`，3 条状态正确） |
| C-08 View Plan | FAIL（按钮不存在） | **PASS** |
| C-09 Build 写清单 + 通知 | FAIL（无 todo/write、无 Approved checklist） | **PASS**（todo/write + 1 条 Approved checklist） |
| C-11 派发戳 | FAIL（frontmatter 无 dispatched） | **PASS**（`dispatched` + `dispatchedChoice` 落盘） |
| C-12 刷新后按钮复活 | FAIL（退回两个 Build 按钮） | **PASS**（刷新后仍是 Dispatched） |

即 0.2.7 报告里 F-1 那条「一个根因，五条 FAIL」在 0.2.10 上已整体消除。

## 五、本轮没跑的条目

A 类 10 条、B 类 9 条、C 类其余 11 条（C-01~C-05、C-07、C-10、C-13~C-16）、D 类 13 条、E 类 8 条、F 类 8 条、H 类 10 条、I 类 8 条 —— 本轮按 brief 只跑 G 类 9 条与 C-06/08/09/11/12 五条，其余沿用 0.2.7 报告的结论（见同目录 `REGRESSION-DESKTOP.md.bak-0.2.7-20261030`），**未在 0.2.10 上复核**。H 类自检脚本尤其需要重跑（0.2.7 期 H-08 `judge-parity --unit` 是红的）。

## 六、桌面端最终状态与本次改动

- 进程：主进程 + 4 个子进程在跑（宿主 pid 11268），`--remote-debugging-port=9222 --enable-logging`
- 窗口：`IsIconic=True`（最小化），rect `-21333,-21333,-21175,-21307`；**不在虚拟桌面 2**，是「最小化 + 屏幕外坐标」这条替代路线
- profile：`C:\Users\ASUS\.dsh\profiles\desktop`，插件 **0.2.10**，bundles = `dsh-base` + `dsh-web-app` + `dsh-cursor-modes`
- 页面：`dsh-app://app/`，停在本次新建的会话
- **本次产生的测试数据（保留未删）**：
  - 会话 `session-296e3f76-3c4c-4e99-a140-8d3d486e9865`（标题「计划卡片验证」，2 个 turn）
  - 计划文件 `C:\Users\ASUS\.dsh\plans\计划卡片验证_ab406f3c.plan.md`（已带 dispatched 戳）
- **本次改过又恢复的配置**（`profiles\desktop\cordis.patch.yml` 的 `cursor-modes.gate`）：
  - `timeoutMs`：2500 → 3000（G-03 验证）→ **2500**（已还原）
  - `backend`：llm → jev（G-06 点 JEV 分支看连接组）→ **llm**（已还原）
  - `enabled`：全程未动，仍是默认 false
  - 结束时 describe 实测：`{enabled:false, backend:"llm", model:"", baseUrl:"http://127.0.0.1:7899/api/v1", timeoutMs:2500, allowConfidence:0.8, workReject:0.2, apiKeyRef:"OPENROUTER_API_KEY"}`，与进场时逐字段一致
- 插件源码未改动；未碰 3080 / 4000 / 3500
