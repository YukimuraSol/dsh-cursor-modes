/**
 * dsh-cursor-modes — the client half: one ModuleLoader entry, fourteen regions.
 *
 * Merged from the two retired frontends (blueprint §7):
 *   dsh-cursor-plan/lib/client.js  → Created Plan turnTail card, its Build
 *                                    buttons, the delegation-gate settings card
 *   dsh-mode-switch/lib/client.js  → the mode chip and its pending selection
 *   dsh-modes/lib/client.js        → a 26-line empty shell, DROPPED, not carried
 *
 * Region order is fixed (§7.2); every header names its old module under the new
 * namespace. The three bridge prefixes moved with the plugin (§7.4) — the old
 * ones belonged to the retired plugin names and no longer exist anywhere:
 *
 *   mode-switch pending bridge  → /api/dsh-cursor-modes/switch    (stage, clear)
 *   cursor-plan build bridge    → /api/dsh-cursor-modes/build
 *   cursor-plan settings bridge → /api/dsh-cursor-modes/settings  (describe, mutate, status)
 *
 * The one semantic change on this side (§7.3): the merged plugin registers ONE
 * session projection, key `mode` (lib/projection.js, stateVersion 4), so
 * currentMode no longer reads a second `cursorPlan` projection — it reads
 * projections.mode.mode, and still lets the official `plan` projection win.
 * The projection's `pending` is now the bare boolean "a switch is in flight";
 * which direction it wants is owned here, by `selections`.
 *
 * Locale: the two old namespaces (cursorPlan, modeSwitch) are merged into the
 * single `cursorModes` NS — one register call, keys grouped `settings.*` /
 * `card.*` / `chip.*` — so the plugin needs one dictionary and the settings tab
 * label can be produced by a single bound `t`.
 *
 * CSS stays inline strings injected through document.createElement("style"),
 * now tagged data-plugin="dsh-cursor-modes".
 */

window.__ModuleLoader__.load({
	id: "dsh-cursor-modes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region dsh-cursor-modes/CreatedPlanCard.module.css
		const css = ".Sc7pKm_card{border:.5px solid var(--dsw-alias-border-l1);background-color:var(--dsw-alias-markdown-code-block);background-image:linear-gradient(var(--dsw-specific-input-major),var(--dsw-specific-input-major));color:var(--dsw-alias-label-primary);border-radius:12px;margin:6px 0 6px 4px;padding:10px 12px;max-width:100%}.Sc7pKm_eyebrow{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.Sc7pKm_title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px;margin:2px 0 8px}.Sc7pKm_body{color:var(--dsw-alias-label-primary);max-height:11em;overflow:hidden}.Sc7pKm_bodyOpen{color:var(--dsw-alias-label-primary);max-height:none}.Sc7pKm_actions{align-items:center;justify-content:space-between;gap:12px;margin-top:8px;display:flex}.Sc7pKm_link{background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:0;text-decoration:underline}.Sc7pKm_link:disabled{opacity:.6;cursor:default}.Sc7pKm_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.Sc7pKm_checklistHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.Sc7pKm_checklistHead>div:first-child{flex:1 1 auto;min-width:0}.Sc7pKm_progress{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto}.Sc7pKm_todos{display:flex;flex-direction:column;gap:7px;margin:6px 0 2px}.Sc7pKm_todo{display:flex;gap:9px;align-items:flex-start;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}.Sc7pKm_todoDone{opacity:.45}.Sc7pKm_box{width:14px;height:14px;border-radius:4px;border:1.5px solid var(--dsw-alias-border-l3);box-sizing:border-box;flex:0 0 auto;margin-top:3px}.Sc7pKm_boxActive{border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid)}.Sc7pKm_boxDone{width:14px;height:14px;border-radius:4px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);flex:0 0 auto;margin-top:3px;font-size:10px;line-height:14px;text-align:center}.Sc7pKm_todoText{flex:1 1 auto;min-width:0}.Sc7pKm_todoTextActive{flex:1 1 auto;min-width:0;font-weight:600}.Sc7pKm_todoTextDone{flex:1 1 auto;min-width:0;text-decoration:line-through}.Sc7pKm_todoLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:6px;white-space:nowrap}.Sc7pKm_checklist{margin:18px 0 0}";
		const tagId = "dsh-cursor-modes/CreatedPlanCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cursor-modes";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const cls = {
			card: "Sc7pKm_card",
			eyebrow: "Sc7pKm_eyebrow",
			title: "Sc7pKm_title",
			body: "Sc7pKm_body",
			bodyOpen: "Sc7pKm_bodyOpen",
			actions: "Sc7pKm_actions",
			link: "Sc7pKm_link",
			error: "Sc7pKm_error",
			checklist: "Sc7pKm_checklist",
			checklistHead: "Sc7pKm_checklistHead",
			progress: "Sc7pKm_progress",
			todos: "Sc7pKm_todos",
			todo: "Sc7pKm_todo",
			todoDone: "Sc7pKm_todoDone",
			box: "Sc7pKm_box",
			boxActive: "Sc7pKm_boxActive",
			boxDone: "Sc7pKm_boxDone",
			todoText: "Sc7pKm_todoText",
			todoTextActive: "Sc7pKm_todoTextActive",
			todoTextDone: "Sc7pKm_todoTextDone",
			todoLabel: "Sc7pKm_todoLabel"
		};
		//#endregion
		//#region dsh-cursor-modes/CreatedPlanCard
		/** The plan's first markdown heading (any level), or "Plan". */
		function heading(markdown) {
			for (const line of String(markdown).split("\n")) {
				const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
				if (match) return match[1];
			}
			return "Plan";
		}
		/** The plan body with its leading heading removed (the title renders it). */
		function bodyOf(markdown) {
			const lines = String(markdown).split("\n");
			const at = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line));
			return at === -1 ? lines.join("\n") : lines.slice(at + 1).join("\n").trim();
		}
		/** Parsed wire arguments of a settled create_plan; null when unusable. */
		function callArgs(block) {
			const call = block && ("kind" in block ? block.call : block);
			if (!call || typeof call.argsRaw !== "string") return null;
			try {
				const value = JSON.parse(call.argsRaw);
				return value && typeof value === "object" ? value : null;
			} catch {
				return null;
			}
		}
		/**
		 * The Created Plan card: the plan document's title, its overview and
		 * opening lines, View Plan (opens the landed file), and the two Build
		 * buttons — Build in Multi (stage Cursor Multi, then build) and Build in
		 * Default (stage default, then build). The full text lives only in the file.
		 *
		 * Mounted on turnTail (not toolview), so the card sits after the closing
		 * reply and is not folded into the turn-process disclosure; the entry
		 * itself declines a turn that settled no plan.
		 */
		function PlanCard({ turn, seq, openFile, buildPlan, t, useProjection }) {
			// The checklist comes from the plan FILE's frontmatter and nowhere else (the
			// file is what create_plan wrote, and editing it is how the checklist is
			// changed later). The session's `todos` projection is deliberately NOT read:
			// it is a second list that can disagree with the file.
			//
			// ponytail: the projection is still read for nothing else here, so this card
			// no longer ticks while a turn works; the file carries the statuses. Writing
			// execution progress back into the file is the separate follow-up.
			// turnTail is a list slot: every entry mounts and there is no chain
			// election, so the card itself declines a turn without a settled plan.
			const matched = selectCreatePlan({ turn, seq });
			const args = matched === null ? null : callArgs({ argsRaw: matched.argsRaw });
			const plan = args && typeof args.plan === "string" ? args.plan : "";
			const overview = args && typeof args.overview === "string" ? args.overview : "";
			const title = heading(plan);
			const body = bodyOf(plan);
			const [open, setOpen] = react.useState(false);
			const [building, setBuilding] = react.useState(false);
			// The plan file the host landed, scraped from the tool result. Read
			// BEFORE the hooks because the dispatch state is keyed on it; a card
			// with no file simply never asks.
			const file = matched === null ? "" : (String(matched.resultText || "").match(/^Plan file: (.+)$/m) || [])[1] || "";
			// Dispatched lives in the plan file's frontmatter (lib/planfile.js), so
			// it survives reloads, reopened sessions and other browsers. null means
			// "the host has not answered yet": the action slot stays empty instead of
			// flashing buttons that are about to disappear.
			const [dispatched, setDispatched] = react.useState(file === "" ? false : null);
			const [error, setError] = react.useState(null);
			// The FILE is the source of truth: the plan-state bridge returns the frontmatter
			// todos, so editing the plan file is enough to change what this card shows - and a
			// plan whose file carries no todos shows no checklist. Declared last so the four
			// hook slots above keep their order (self-check-bridge seeds dispatch in slot 2).
			const [todos, setTodos] = react.useState([]);
			react.useEffect(() => {
				if (file === "" || dispatched !== null) return undefined;
				let alive = true;
				fetch(PLAN_STATE_BRIDGE + "?path=" + encodeURIComponent(file)).then((response) => response.json()).then((answer) => {
					if (!alive) return;
					const value = answer && answer.ok === true ? answer.value : null;
					if (value && value.invalid !== undefined) {
						console.warn("[dsh-cursor-modes] plan " + file + " carries an invalid dispatched value (" + String(value.invalid) + "); showing the Build buttons");
					}
					setDispatched(value ? value.dispatched === true : false);
					setTodos(value && Array.isArray(value.todos) ? value.todos : []);
				}, () => {
					if (alive) setDispatched(false);
				});
				return () => {
					alive = false;
				};
			}, [file]);
			const aliveRef = react.useRef(true);
			react.useEffect(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);
			if (matched === null) return null;
			const build = (choice) => {
				if (dispatched === true) return;
				setDispatched(true);
				setBuilding(true);
				setError(null);
				// The click carries the checklist the card is showing, so the host
				// writes it into the session as the approval's first `todo/write`.
				buildPlan(choice, todos, file).then((failure) => {
					if (!aliveRef.current) return;
					setBuilding(false);
					setError(failure);
				}, (reason) => {
					if (!aliveRef.current) return;
					setBuilding(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			// The execution checklist: the third part of the plan, rendered as the
			// body's natural continuation — same `##` heading level, no rule above
			// it, no box of its own. The heading text is literal Chinese because the
			// body's headings are, whatever the UI language is.
			//
			// It mounts INSIDE the body container (`cls.body` / `cls.bodyOpen`), not
			// beside it: the 11em clamp lives on that container, so a sibling would
			// ride outside the fold and print the whole list under a two-line plan.
			// The action row stays outside for the same reason in reverse — a button
			// may never be clipped.
			const done = todos.filter((todo) => todo && todo.status === "completed").length;
			const boxOf = (status) => status === "completed" ? react.createElement("span", {
				key: "box",
				className: cls.boxDone,
				"aria-hidden": "true"
			}, "✓") : react.createElement("span", {
				key: "box",
				className: status === "in_progress" ? cls.boxActive : cls.box,
				"aria-hidden": "true"
			});
			const checklist = todos.length === 0 ? null : react.createElement("div", {
				className: cls.checklist,
				"data-plan-checklist": "1"
			}, react.createElement("div", { className: cls.checklistHead }, react.createElement(primitives.MarkdownText, {
				text: "## 执行清单",
				labels: {
					code: { copyLabel: t("card.copy"), copiedLabel: t("card.copied") },
					footnotes: t("card.footnotes")
				}
			}), react.createElement("div", { className: cls.progress }, done + " / " + todos.length)), react.createElement("div", { className: cls.todos }, todos.map((todo, index) => {
				const raw = todo && typeof todo === "object" ? todo : {};
				const status = raw.status === "completed" ? "completed" : raw.status === "in_progress" ? "in_progress" : "pending";
				return react.createElement("div", {
					key: String(raw.id !== undefined ? raw.id : index),
					className: status === "completed" ? cls.todo + " " + cls.todoDone : cls.todo,
					"data-todo-status": status
				}, boxOf(status), react.createElement("span", {
					className: status === "completed" ? cls.todoTextDone : status === "in_progress" ? cls.todoTextActive : cls.todoText
				}, String(raw.content !== undefined ? raw.content : "")), status === "in_progress" && react.createElement("span", { className: cls.todoLabel }, "进行中"));
			})));
			return react.createElement("section", {
				className: cls.card,
				"data-created-plan": "1"
			}, react.createElement("div", { className: cls.eyebrow }, t("card.eyebrow")), react.createElement("div", { className: cls.title }, title),
				overview !== "" && react.createElement("div", {
					style: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px", margin: "0 0 8px" }
				}, overview),
				react.createElement("div", { className: open ? cls.bodyOpen : cls.body }, react.createElement(primitives.MarkdownText, {
					text: body,
					labels: {
						code: { copyLabel: t("card.copy"), copiedLabel: t("card.copied") },
						footnotes: t("card.footnotes")
					}
				}), checklist), react.createElement("div", { className: cls.actions }, react.createElement("div", {
				style: { display: "flex", gap: "12px", alignItems: "center" }
			}, body !== "" && react.createElement("button", {
				type: "button",
				className: cls.link,
				onClick: () => setOpen((value) => !value)
			}, open ? t("card.collapse") : t("card.expand")), file !== "" && react.createElement("button", {
				type: "button",
				className: cls.link,
				onClick: () => { if (typeof openFile === "function") openFile(file); }
			}, t("card.view"))), react.createElement("div", {
				style: { display: "flex", gap: "12px", alignItems: "center" }
			}, dispatched === true ? react.createElement("span", {
				className: cls.link,
				"data-plan-dispatched": "1",
				// Same font, size and colour as the buttons it replaced; only the
				// affordances go away - no underline, no pointer, no dimming.
				style: { textDecoration: "none", cursor: "default" }
			}, "Dispatched") : dispatched === false ? react.createElement(react.Fragment, null, react.createElement("button", {
				type: "button",
				className: cls.link,
				disabled: building,
				onClick: () => build("multi")
			}, t("card.buildMulti")), react.createElement("button", {
				type: "button",
				className: cls.link,
				disabled: building,
				onClick: () => build("default")
			}, t("card.buildDefault"))) : null)), error !== null && react.createElement("div", {
				className: cls.error,
				role: "status",
				title: error
			}, t("card.buildFailed")));
		}
		//#region dsh-cursor-modes/create-plan-fold
		/** Wire tool name this card settles from. */
		const PLAN_TOOL = "create_plan";
		/** Session event carrying an on-disk plan body after a `.plan.md` edit. */
		const PLAN_DOC_EVENT = "cursorPlan/planDoc";
		/** The plan-body plugin record written since 0.2.4 — same payload, same card. */
		const PLAN_DOC_RECORD = "plugin:cursormodes/plandoc";
		/**
		 * True for every spelling of the plan-body event a readable log can hold:
		 * `cursorPlan/planDoc`, its migrated `plugin:cursorPlan/planDoc`, and the
		 * 0.2.4 record `plugin:cursormodes/plandoc`. Mirrors isPlanDocEvent in
		 * create-plan-fold.js — keep both copies in sync.
		 */
		function isPlanDocEvent(type) {
			const name = typeof type === "string" && type.startsWith("plugin:") ? type.slice(7) : type;
			return name === PLAN_DOC_EVENT || name === "cursormodes/plandoc";
		}
		/** Turn-data key published beside Chat nodes. */
		const TURN_DATA_KEY = "cursor-plan";
		/**
		 * Pure create_plan fold inlined from create-plan-fold.js — ModuleLoader
		 * bundles cannot import local modules; keep both copies in sync.
		 */
		/** Text of the first text block in a tool-result message, or "". */
		function toolResultText(message) {
			const outer = message && Array.isArray(message.content) ? message.content[0] : undefined;
			const blocks = outer && Array.isArray(outer.content) ? outer.content : [];
			const texts = [];
			for (const block of blocks) {
				if (block && block.type === "text" && typeof block.text === "string") texts.push(block.text);
			}
			return texts.join("\n");
		}
		/** Text joined from a PTC dispatch `content` array, or "". */
		function ptcResultText(content) {
			if (!Array.isArray(content)) return "";
			const texts = [];
			for (const block of content) {
				if (block && block.type === "text" && typeof block.text === "string") texts.push(block.text);
			}
			return texts.join("\n");
		}
		/** JSON string for PlanCard's callArgs parser. PTC arguments are already objects. */
		function argsRawOf(args) {
			if (typeof args === "string") return args;
			return JSON.stringify(args ?? {});
		}
		/** callId → turn so PTC sub-dispatches (no turn field) join the same context. */
		const callTurn = new Map();
		/**
		 * Turn-local accumulator of successful create_plan settlements. Publishes
		 * no Chat node; turnTail reads the Location value. Native tool/call and
		 * PTC tool/ptc-dispatch-start|dispatch both settle into the same shape.
		 */
		const createPlanDefinition = {
			kind: "cursor-plan",
			match: (event) => {
				if (event.type === "turn/start") return {
					id: String(event.data.turn),
					role: "start"
				};
				if (event.type === "tool/call") {
					const callId = event.data.callId;
					const turn = event.data.turn;
					if (callId != null && typeof turn === "number") callTurn.set(String(callId), turn);
					if (event.data.name === PLAN_TOOL) return {
						id: String(turn),
						role: "update"
					};
					return null;
				}
				if (event.type === "tool/result" && event.surfaceOp === "append") return {
					id: String(event.data.turn),
					role: "update"
				};
				if ((event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") && event.data.name === PLAN_TOOL) {
					const turn = callTurn.get(String(event.data.rootCallId)) ?? callTurn.get(String(event.data.parentCallId));
					if (turn === undefined) return null;
					return {
						id: String(turn),
						role: "update"
					};
				}
				if (isPlanDocEvent(event.type)) {
					const turn = event.data.turn;
					if (typeof turn !== "number") return null;
					return {
						id: String(turn),
						role: "update"
					};
				}
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("cursor-plan start requires turn/start");
				return {
					turn: match.event.data.turn,
					calls: new Map(),
					plans: []
				};
			},
			update: (context, match) => {
				const event = match.event;
				if (event.type === "tool/call") {
					const calls = new Map(context.state.calls);
					calls.set(String(event.data.callId), event.data.arguments);
					return {
						...context.state,
						calls
					};
				}
				if (event.type === "tool/ptc-dispatch-start") {
					const calls = new Map(context.state.calls);
					calls.set(String(event.data.subCallId), argsRawOf(event.data.arguments));
					return {
						...context.state,
						calls
					};
				}
				if (event.type === "tool/result") {
					const message = event.data.message;
					const outer = message && Array.isArray(message.content) ? message.content[0] : undefined;
					if (outer && outer.isError === true) return context.state;
					const callId = String(message.source.callId);
					const argsRaw = context.state.calls.get(callId);
					if (argsRaw === undefined) return context.state;
					return {
						...context.state,
						plans: [...context.state.plans, {
							seq: event.seq,
							argsRaw,
							resultText: toolResultText(message)
						}]
					};
				}
				if (event.type === "tool/ptc-dispatch") {
					if (event.data.isError === true) return context.state;
					const callId = String(event.data.subCallId);
					const argsRaw = context.state.calls.get(callId);
					if (argsRaw === undefined) return context.state;
					return {
						...context.state,
						plans: [...context.state.plans, {
							seq: event.seq,
							argsRaw,
							resultText: ptcResultText(event.data.content)
						}]
					};
				}
				if (isPlanDocEvent(event.type)) {
					const path = typeof event.data.path === "string" ? event.data.path : "";
					const plan = typeof event.data.plan === "string" ? event.data.plan : "";
					return {
						...context.state,
						plans: [...context.state.plans, {
							seq: event.seq,
							argsRaw: JSON.stringify({ plan }),
							resultText: path === "" ? "" : `Plan file: ${path}\n`
						}]
					};
				}
				return context.state;
			},
			buildLocationData: (context, scope, previous) => {
				if (scope !== "turn" || context.state === undefined) return null;
				if (previous && previous.kind === "turn" && previous.turn === context.state.turn && previous.key === TURN_DATA_KEY && previous.value.plans === context.state.plans) return previous;
				return {
					kind: "turn",
					turn: context.state.turn,
					key: TURN_DATA_KEY,
					value: { plans: context.state.plans }
				};
			}
		};
		/**
		 * The turn-tail entry's own claim rule (the slot is a list, so nothing
		 * elects the entry): the latest create_plan that settled before the closing
		 * assistant seq, or null when this turn settled none.
		 */
		function selectCreatePlan(owner) {
			const plans = owner.turn.data.get(TURN_DATA_KEY)?.plans ?? [];
			let latest = null;
			for (const plan of plans) {
				if (plan.seq < owner.seq) latest = plan;
			}
			return latest;
		}
		//#endregion
		//#endregion
		//#region dsh-cursor-modes/modeNotice
		/**
		 * Durable source kind stamped on this plugin's switch notice (lib/state.js
		 * commitPending). Only that kind is ours: the multi-mode budget notice wears
		 * `dsh-modes`, and another plugin's notice must keep its own row.
		 */
		const SWITCH_NOTICE_KIND = "dsh-cursor-modes";
		/** Chat renderer kind this Definition owns; one visible line per switch notice. */
		const SWITCH_NOTICE_NODE_KIND = "cursor-mode-notice";
		/**
		 * The one-line account a switch notice records, or null when this event is
		 * not one. The host writes `source.form === 'notice'` and puts the exact
		 * line the GUI shows in `source.summary`, so the row needs no content parse.
		 * @param event - durable Client history event.
		 * @returns the summary line, or null when unrelated.
		 */
		function switchNoticeSummary(event) {
			if (event.type !== "user/message" || (event.surfaceOp !== undefined && event.surfaceOp !== "append")) return null;
			const data = event.data;
			const source = data && data.source;
			if (!source || source.kind !== SWITCH_NOTICE_KIND || source.form !== "notice") return null;
			return typeof source.summary === "string" && source.summary !== "" ? source.summary : null;
		}
		/**
		 * Project this plugin's switch notices to a visible Chat row.
		 *
		 * The shipped projection sends every non-`user` source to the `context`
		 * kind, and chat-visibility hides ordinary Context unless it injects tool
		 * changes — which is why the notice existed in the log but never in the DOM.
		 * This Definition owns the same events on the chat target and emits its own
		 * renderer kind, so the line is materialized from the durable log and comes
		 * back after a refresh.
		 *
		 * `groupTree: "input"` is load-bearing: chat-visibility folds everything
		 * inside the `turn` position into the completed-turn process disclosure, and
		 * an input-position node stays outside it.
		 */
		const switchNoticeDefinition = {
			kind: SWITCH_NOTICE_NODE_KIND,
			target: "chat",
			match: (event) => {
				const summary = switchNoticeSummary(event);
				return summary === null ? null : {
					id: String(event.data.id),
					role: "start"
				};
			},
			start: (_context, match) => ({
				seq: match.event.seq,
				time: match.event.time,
				summary: switchNoticeSummary(match.event)
			}),
			update: (context) => context.state,
			buildViewNode: (context) => {
				const state = context.state;
				if (state === undefined || context.start === undefined || state.summary === null) return null;
				return {
					key: context.key,
					kind: SWITCH_NOTICE_NODE_KIND,
					id: context.id,
					target: "chat",
					anchorSeq: state.seq,
					location: context.start.location,
					visibility: "visible",
					groupTree: "input",
					data: {
						summary: state.summary,
						seq: state.seq,
						time: state.time
					}
				};
			}
		};
		const noticeCss = ".CmSwNt_line{color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));margin:2px 0;padding-left:2px}";
		const noticeTagId = "dsh-cursor-modes/ModeNotice.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(noticeTagId) + "]") === null) {
			const noticeTag = document.createElement("style");
			noticeTag.dataset.plugin = "dsh-cursor-modes";
			noticeTag.dataset.pluginCss = noticeTagId;
			noticeTag.textContent = noticeCss;
			document.head.appendChild(noticeTag);
		}
		/**
		 * The switch notice row: exactly the one line the host recorded, with no
		 * bubble, actions, or expansion. Keyed Chat renderer for
		 * {@link SWITCH_NOTICE_NODE_KIND}.
		 * @param props - keyed Chat node plus the owner seats.
		 * @returns the notice line.
		 */
		function SwitchNoticeLine(props) {
			const data = props.node.data;
			return react.createElement("div", {
				className: "CmSwNt_line",
				"data-cursor-mode-notice": "1"
			}, data.summary);
		}
		//#endregion
		//#region dsh-cursor-modes/buildButtons
		/**
		 * The two halves of one Build click. Each is a strict order: stage the target
		 * mode on the pending bridge (a memory write — no command, no
		 * session event), then ask this plugin's host half to write the one message
		 * that starts the build. The host applies the staged mode as a net
		 * change when that message lands in the inbox, so a click that is already in
		 * its target mode appends nothing at all.
		 *
		 * Deliberately not a command: every resolved execution appends
		 * `command/run` + `command/done`, and the conversation renders that pair as a
		 * persistent receipt — the storm the mode control exists to avoid.
		 */
		/** This plugin's pending-mode bridge (`/stage`, `/clear`). */
		const MODE_BRIDGE = "/api/dsh-cursor-modes/switch";
		/** This plugin's build bridge, served from lib/build.js. */
		const BUILD_BRIDGE = "/api/dsh-cursor-modes/build";
		/** The bridge's read half: one plan file's dispatch stamp. */
		const PLAN_STATE_BRIDGE = "/api/dsh-cursor-modes/plan-state";
		/** Button choice → the mode id dsh-mode-switch stages for it. */
		const BUILD_TARGETS = {
			multi: "multi",
			default: "default"
		};
		/** POST one bridge path; every answer is JSON, refusals included. */
		const postBridge = async (path, body) => {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			return response.json();
		};
		/** One bridge refusal's text, or null when the answer accepted. */
		const refusalOf = (answer, what) => answer?.ok === true ? null : `${what} refused: ${answer?.message ?? answer?.code ?? "no answer"}`;
		/**
		 * One Build button, as the action the card awaits: `null` on success, otherwise
		 * the line the card shows. The transport is injected only for the self-check.
		 *
		 * A failed stage aborts the build — building in the wrong mode is worse than
		 * not building — and a failed build retracts the staged mode, so a target that
		 * never reached a message can never leak onto the user's next send.
		 *
		 * @param sessionId - the session the card belongs to.
		 * @param transport - the bridge call, injected for the self-check.
		 * @returns the click handler the card binds: `(choice, todos?)`. The
		 *   checklist rides along so the host can write it into the session as
		 *   the approval's first `todo/write` — id dropped, content + status only,
		 *   which is exactly what `todo_write` takes.
		 */
		function createBuild(sessionId, transport = postBridge) {
			return async (choice, todos, planFile) => {
				const target = BUILD_TARGETS[choice];
				if (target === undefined) return "unknown build choice: " + choice;
				try {
					const stageFailure = refusalOf(await transport(MODE_BRIDGE + "/stage", {
						sessionId,
						target
					}), "the mode switch");
					if (stageFailure !== null) return stageFailure;
					const body = {
						sessionId,
						choice
					};
					const list = Array.isArray(todos) ? todos : [];
					if (list.length > 0) body.todos = list.map(({ content, status }) => ({ content, status }));
					// The host stamps this plan's frontmatter before answering, so the
					// card's permanent state is the file's, not this tab's memory.
					if (typeof planFile === "string" && planFile !== "") body.planFile = planFile;
					const buildFailure = refusalOf(await transport(BUILD_BRIDGE, body), "the build");
					if (buildFailure === null) return null;
					await transport(MODE_BRIDGE + "/clear", { sessionId });
					return buildFailure;
				} catch (reason) {
					return reason instanceof Error ? reason.message : String(reason);
				}
			};
		}
		//#endregion
		//#region dsh-cursor-modes/CursorPlanSettingsCard.module.css
		// The card is drawn from the same parts every other plugin settings panel in
		// this harness is drawn from (dsh-my-notify, dsh-unrestricted): a stack of
		// rows on --dsw-alias-bg-layer-2 with an 8px radius, 13px/500 row labels,
		// 12px hints in --dsw-alias-label-tertiary, 28px controls at a 6px radius,
		// and the panel's own 10px stacking rhythm. Every colour is a theme token
		// and every size comes from the --dsw-font-* / --dsw-radius-* scale, so the
		// card follows the skin in both themes instead of overriding it.
		const settingsCss = [
			// One surface, not a stack of floating cards: the wallpaper behind this
			// panel is busy, and six translucent boxes let the art show through the
			// text. A single blurred sheet with hairline rules keeps the skin's
			// translucency and gives the rows one silhouette to sit in.
			".Cp8sVz_card{flex-direction:column;min-width:0;display:flex;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);backdrop-filter:blur(14px) saturate(1.15);overflow:hidden;box-sizing:border-box}",
			".Cp8sVz_card>*+*{border-top:1px solid var(--dsw-alias-border-l1)}",
			".Cp8sVz_row{align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;min-width:0;display:flex;box-sizing:border-box}",
			".Cp8sVz_rowTop{align-items:flex-start;padding:12px 12px 10px}",
			".Cp8sVz_info{flex-direction:column;gap:2px;min-width:0;display:flex}",
			// Four steps, and they must stay four: the card title is the only 600, the
			// row labels are regular, the hints are the 12px step, and the meta line
			// under them is the quietest. Weight carries the top of that ladder, not
			// colour alone.
			".Cp8sVz_title{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);font-weight:600}",
			".Cp8sVz_label{color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);margin:0}",
			".Cp8sVz_hint{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.5}",
			".Cp8sVz_code{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code);padding:0 1px}",
			".Cp8sVz_control{align-items:center;flex:none;gap:6px;display:flex}",
			".Cp8sVz_switch{position:relative;flex:none;width:34px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent);cursor:pointer;box-sizing:border-box;transition:background-color .16s ease,border-color .16s ease}",
			".Cp8sVz_switch:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
			".Cp8sVz_switchOn{background:var(--dsw-alias-state-business-primary);border-color:transparent}",
			".Cp8sVz_switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
			".Cp8sVz_switch:disabled{opacity:.5;cursor:default}",
			".Cp8sVz_knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .16s ease,background-color .16s ease}",
			".Cp8sVz_switchOn .Cp8sVz_knob{transform:translateX(14px);background:var(--dsw-alias-label-primary-foreground)}",
			".Cp8sVz_seg{flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);display:inline-flex;overflow:hidden}",
			".Cp8sVz_segBtn{align-items:center;justify-content:center;height:26px;padding:0 10px;border:0;background:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);white-space:nowrap;display:inline-flex;cursor:pointer;transition:background-color .13s,color .13s}",
			".Cp8sVz_segBtn+.Cp8sVz_segBtn{border-left:1px solid var(--dsw-alias-border-l2)}",
			".Cp8sVz_segOn{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12)}",
			".Cp8sVz_segOff{color:var(--dsw-alias-label-tertiary)}",
			".Cp8sVz_segBtn:hover:not(:disabled):not(.Cp8sVz_segOn){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".Cp8sVz_segBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}",
			".Cp8sVz_segBtn:disabled{cursor:default}",
			".Cp8sVz_selectRow{align-items:center;flex:none;gap:4px;width:220px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);display:flex;box-sizing:border-box;transition:border-color .13s,box-shadow .13s}",
			".Cp8sVz_selectHint{flex:none;color:var(--dsw-alias-label-caption);font:var(--dsw-font-xxxs-11);line-height:1}",
			// One column: the reference field and every advanced field are the same
			// width as the select above them, so their left edges line up too.
			".Cp8sVz_input{flex:none;width:220px;min-width:0;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);box-sizing:border-box;transition:border-color .13s,box-shadow .13s}",
			".Cp8sVz_input::placeholder{color:var(--dsw-alias-label-dimmed)}",
			".Cp8sVz_input:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
			".Cp8sVz_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}",
			".Cp8sVz_input:disabled{opacity:.6;cursor:default}",
			".Cp8sVz_groupHead{align-items:center;gap:8px;padding:12px 12px 4px;min-width:0;display:flex;box-sizing:border-box}",
			".Cp8sVz_groupLabel{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);letter-spacing:.04em}",
			".Cp8sVz_grid{gap:10px;padding:10px 12px 12px;grid-template-columns:repeat(3,minmax(0,1fr));display:grid;box-sizing:border-box}",
			".Cp8sVz_cell{flex-direction:column;gap:5px;min-width:0;display:flex}",
			".Cp8sVz_cellLabel{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".Cp8sVz_cellHint{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);line-height:1.45}",
			".Cp8sVz_inputWide{width:100%}",
			".Cp8sVz_selectFixed{opacity:1;cursor:default}",
			".Cp8sVz_selectText{flex:1;min-width:0;line-height:26px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".Cp8sVz_reveal{flex:none;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background-color .13s,border-color .13s}",
			".Cp8sVz_reveal:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}",
			".Cp8sVz_reveal:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
			".Cp8sVz_reveal:disabled{opacity:.6;cursor:default}",
			".Cp8sVz_error{padding:0 2px;color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12);line-height:1.5}",
			// A <button> keeps the UA's grey face unless told otherwise, and that slab
			// was the greyest thing on the card. The row paints nothing; hover tints.
			".Cp8sVz_foot{width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:transparent;border:0;transition:background-color .13s}",
			".Cp8sVz_foot:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".Cp8sVz_foot:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
			".Cp8sVz_advancedLabel{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-strong-13)}",
			".Cp8sVz_summary{flex:none;max-width:64%;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".Cp8sVz_fields{flex-direction:column;display:flex}",
			".Cp8sVz_field{align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;min-width:0;display:flex;box-sizing:border-box}",
			".Cp8sVz_field+.Cp8sVz_field{border-top:1px solid var(--dsw-alias-border-l1)}",
			".Cp8sVz_fieldText{flex-direction:column;gap:2px;min-width:0;display:flex}",
			".Cp8sVz_fieldLabel{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}",
			".Cp8sVz_fieldHint{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);line-height:1.5}",
			// Narrow: every control takes its own line and fills it, so nothing is
			// squeezed or pushed past the sheet's edge. The header row is the one
			// exception — its switch stays in the corner it belongs to.
			"@media (max-width:760px){.Cp8sVz_row:not(.Cp8sVz_rowTop){flex-direction:column;align-items:stretch}.Cp8sVz_selectRow,.Cp8sVz_input,.Cp8sVz_seg{width:100%}.Cp8sVz_control{flex-direction:column;align-items:flex-start;width:100%}.Cp8sVz_segBtn{flex:1}.Cp8sVz_controlRow{flex-direction:row;align-items:center;width:100%}.Cp8sVz_controlRow .Cp8sVz_input{flex:1;min-width:0;width:auto}.Cp8sVz_field{flex-direction:column;align-items:stretch}.Cp8sVz_grid{grid-template-columns:minmax(0,1fr)}.Cp8sVz_summary{max-width:100%;white-space:normal;text-align:left}}"
		].join("");
		const settingsTagId = "dsh-cursor-modes/CursorPlanSettingsCard.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(settingsTagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cursor-modes";
			tag.dataset.pluginCss = settingsTagId;
			tag.textContent = settingsCss;
			document.head.appendChild(tag);
		}
		const settings = {
			card: "Cp8sVz_card",
			row: "Cp8sVz_row",
			rowTop: "Cp8sVz_rowTop",
			info: "Cp8sVz_info",
			title: "Cp8sVz_title",
			label: "Cp8sVz_label",
			hint: "Cp8sVz_hint",
			code: "Cp8sVz_code",
			control: "Cp8sVz_control",
			switch: "Cp8sVz_switch",
			switchOn: "Cp8sVz_switchOn",
			knob: "Cp8sVz_knob",
			seg: "Cp8sVz_seg",
			segBtn: "Cp8sVz_segBtn",
			segOn: "Cp8sVz_segOn",
			segOff: "Cp8sVz_segOff",
			selectRow: "Cp8sVz_selectRow",
			selectFixed: "Cp8sVz_selectFixed",
			selectText: "Cp8sVz_selectText",
			selectHint: "Cp8sVz_selectHint",
			input: "Cp8sVz_input",
			groupHead: "Cp8sVz_groupHead",
			groupLabel: "Cp8sVz_groupLabel",
			grid: "Cp8sVz_grid",
			cell: "Cp8sVz_cell",
			cellLabel: "Cp8sVz_cellLabel",
			cellHint: "Cp8sVz_cellHint",
			inputWide: "Cp8sVz_inputWide",
			controlRow: "Cp8sVz_controlRow",
			reveal: "Cp8sVz_reveal",
			error: "Cp8sVz_error",
			foot: "Cp8sVz_foot",
			advancedLabel: "Cp8sVz_advancedLabel",
			summary: "Cp8sVz_summary",
			fields: "Cp8sVz_fields",
			field: "Cp8sVz_field",
			fieldText: "Cp8sVz_fieldText",
			fieldLabel: "Cp8sVz_fieldLabel",
			fieldHint: "Cp8sVz_fieldHint"
		};
		//#endregion
		//#region dsh-cursor-modes/CursorPlanSettingsCard
		/** Host bridge this card reads and writes through (loopback only, POST only). */
		const BRIDGE = "/api/dsh-cursor-modes/settings";
		/** POST one bridge path; every answer is JSON, refusals included. */
		const bridge = async (path, body) => {
			const response = await fetch(BRIDGE + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {})
			});
			return response.json();
		};
		/**
		 * The endpoint an empty API address means: this machine's own gateway, the one
		 * process here that serves the jev models. The host carries the same literal
		 * (DEFAULT_JEV_BASE_URL), so the placeholder cannot drift from the request.
		 */
		const DEFAULT_BASE_URL = "http://127.0.0.1:7899/api/v1";
		/**
		 * Editable advanced fields, in card order, as the two branches read them.
		 * jevOnly marks the two thresholds: they belong to the decision model's measured
		 * verdict, and the follow branch has no numbers to threshold, so it hides them
		 * instead of showing dead controls. The connection is NOT here — it is its own
		 * group further down, JEV-only, because a deployment that follows the session
		 * model has no endpoint of its own to fill.
		 */
		const GATE_FIELDS = [
			{ key: "timeoutMs", label: "settings.timeout", hint: "settings.timeoutHint", type: "number", step: 100, min: 1 },
			{ key: "allowConfidence", label: "settings.allowConfidence", hint: "settings.allowConfidenceHint", type: "number", step: 0.05, min: 0, max: 1, jevOnly: true },
			{ key: "workReject", label: "settings.workReject", hint: "settings.workRejectHint", type: "number", step: 0.05, min: 0, max: 1, jevOnly: true }
		];
		/**
		 * The JEV connection, in card order: the decision model's own route — the id it
		 * is asked with, the endpoint it is asked at, and the key it is asked with. It
		 * is JEV-only by nature. The follow branch asks the session's own model through
		 * the harness llm service, so it has no route of its own to fill, and this whole
		 * group is absent there (the pattern of a JEV-only block, not a hidden one).
		 */
		const CONNECTION_FIELDS = [
			{ key: "model", label: "settings.modelId", hint: "settings.modelIdHint", type: "text", placeholder: "jev-latest" },
			{ key: "baseUrl", label: "settings.baseUrl", hint: "settings.baseUrlHint", type: "text", placeholder: DEFAULT_BASE_URL },
			{ key: "apiKey", label: "settings.apiKey", hint: "settings.apiKeyHint", type: "secret" }
		];
		/** The last illegal backend already complained about, so one bad value warns once. */
		let warnedBackend = null;
		/**
		 * The judge source the card shows, normalized.
		 *
		 * Same rule as the host's own judgeBackend() (lib/cursor-plan.js): the two legal
		 * values pass through, everything else is JEV — the backend that fails closed,
		 * and the one a host that predates backend is running. A stored value that is
		 * neither is also reported on the console, once per distinct value, so a broken
		 * config is visible instead of silently normalised.
		 */
		function judgeBackendOf(values) {
			const raw = values == null ? undefined : values.backend;
			if (raw === "jev" || raw === "llm") return raw;
			if (raw === undefined) return "jev";
			if (raw !== warnedBackend) {
				warnedBackend = raw;
				console.warn("dsh-cursor-modes: judge backend must be jev or llm, got " + JSON.stringify(raw) + " — rendering jev");
			}
			return "jev";
		}
		/**
		 * The API address as it may be stored: trimmed, every trailing slash dropped.
		 * The empty string is kept — that is how the card says "use the shipped
		 * default" — and the host normalises the same way (normalizeBaseUrl in
		 * lib/cursor-plan.js), so a value saved here reads back identically.
		 */
		function normalizeBaseUrl(value) {
			return String(value ?? "").trim().replace(/\/+$/, "");
		}
		/**
		 * Whether an API address is storable, checked before the write so a typo is
		 * refused on the spot instead of by the host's own rejection one round trip
		 * later. Same rule as the host: empty is legal, everything else must be an
		 * absolute http(s) URL.
		 *
		 * @param {string} value
		 * @returns {string | null} the message key to show, or null when storable.
		 */
		function baseUrlProblem(value) {
			const normalized = normalizeBaseUrl(value);
			if (normalized === "") return null;
			return /^https?:\/\/[^\s/]+/i.test(normalized) ? null : "settings.baseUrlInvalid";
		}
		/**
		 * The description with its inline code spans, the way the design draws it: the
		 * sentence carries subagent and send_message in backticks, and each backticked
		 * run becomes a <code> node. One localized string instead of three fragments,
		 * so a translator edits a sentence, not a tree.
		 */
		function descNodes(text) {
			const parts = [];
			const pattern = /\x60([^\x60]+)\x60/g;
			let last = 0;
			let match;
			while ((match = pattern.exec(text)) !== null) {
				if (match.index > last) parts.push(text.slice(last, match.index));
				parts.push(react.createElement("code", {
					className: settings.code,
					key: "code-" + parts.length
				}, match[1]));
				last = match.index + match[0].length;
			}
			if (last < text.length) parts.push(text.slice(last));
			return parts;
		}
		/**
		 * The delegation gate's card in 设置 → 插件 → 插件配置, keyed on the
		 * cursor-modes settings namespace. The host owns the state: this reads
		 * /describe on mount, writes one field at a time through /mutate, and adopts
		 * the effective values (and the key's configured flag) from that response — so
		 * what the card shows is the judge's own view, never client optimism.
		 *
		 * The card has two shapes. 跟随当前模型 asks the session's own model: one fixed
		 * model row, and a timeout. JEV 专用判官 asks the decision model through its own
		 * route: no model row at the top (the id lives in the connection), the two
		 * thresholds next to the timeout, and the connection group underneath.
		 */
		function CursorPlanSettingsCard({ t }) {
			const [view, setView] = react.useState(null);
			const [draft, setDraft] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			// 高级设置 is the card's one disclosure, and it starts shut: the collapsed
			// row already prints the numbers it hides, so nothing needs opening to be read.
			const [advancedOpen, setAdvancedOpen] = react.useState(false);
			// The key is masked until 显示 is pressed. This is view state only: the box
			// never holds a stored value, so revealing it reveals what was just typed.
			const [keyReveal, setKeyReveal] = react.useState(false);
			const aliveRef = react.useRef(true);
			react.useEffect(() => {
				aliveRef.current = true;
				refresh();
				return () => {
					aliveRef.current = false;
				};
			}, []);
			/**
			 * The draft the boxes render. The key is seeded empty on every read and every
			 * write: the host answers one boolean instead of the value, so this box only
			 * ever holds what the reader typed into it — and an empty box means "keep the
			 * stored key", never "clear it".
			 */
			function adopt(values) {
				return { ...values, apiKey: "" };
			}
			/** Read the effective values, one round trip. */
			async function refresh() {
				try {
					const described = await bridge("/describe");
					if (!aliveRef.current) return;
					if (described.ok !== true) {
						setView(null);
						setError(described.message ?? t("settings.unavailable"));
						return;
					}
					setView({
						values: described.value.values,
						apiKeyConfigured: described.value.apiKeyConfigured === true
					});
					setDraft(adopt(described.value.values));
					setKeyReveal(false);
					setError(null);
				} catch (reason) {
					if (!aliveRef.current) return;
					setError(reason instanceof Error ? reason.message : String(reason));
				}
			}
			/** Write one patch and adopt the response's effective values. */
			async function commit(patch) {
				setBusy(true);
				setError(null);
				try {
					const result = await bridge("/mutate", { patch });
					if (!aliveRef.current) return;
					if (result.ok !== true) {
						setError(result.message ?? t("settings.saveFailed"));
						return;
					}
					// The answer carries the key's own boolean for whatever is stored now, and
					// never the key: the box is emptied here even when the write was the key
					// itself, so a saved key leaves no value behind on the screen.
					setView({
						values: result.value,
						apiKeyConfigured: result.apiKeyConfigured === true
					});
					setDraft(adopt(result.value));
					setKeyReveal(false);
				} catch (reason) {
					if (!aliveRef.current) return;
					setError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					if (aliveRef.current) setBusy(false);
				}
			}
			/** Local edit; the write happens on blur. */
			function edit(key, value) {
				setDraft((previous) => previous === null ? previous : { ...previous, [key]: value });
				setError(null);
			}
			/** Commit one typed advanced field when the reader leaves it. */
			function saveField(field) {
				if (draft === null || view === null) return;
				const raw = draft[field.key];
				const next = Number(raw);
				if (String(raw ?? "").trim() === "" || Number.isNaN(next)) {
					setError(t("settings.numberInvalid"));
					return;
				}
				if (next === view.values[field.key]) return;
				commit({ [field.key]: next });
			}
			/**
			 * Commit one connection field when the reader leaves it. The key is special: an
			 * empty box means "leave the stored key alone", never "clear it", so typing
			 * nothing — or deleting what was typed — can never wipe a saved key. The model
			 * id and the endpoint are ordinary strings, and emptying those does clear them.
			 */
			function saveConnection(field) {
				if (draft === null || view === null) return;
				const raw = String(draft[field.key] ?? "").trim();
				if (field.key === "apiKey") {
					if (raw === "") return;
					commit({ apiKey: raw });
					return;
				}
				if (field.key === "baseUrl") {
					const problem = baseUrlProblem(raw);
					if (problem !== null) {
						setError(t(problem));
						return;
					}
					const normalized = normalizeBaseUrl(raw);
					setDraft({ ...draft, baseUrl: normalized });
					if (normalized === normalizeBaseUrl(view.values.baseUrl)) return;
					commit({ baseUrl: normalized });
					return;
				}
				if (raw === String(view.values.model ?? "")) return;
				commit({ model: raw });
			}
			/** The switch is the one control that saves on click. */
			function toggleEnabled() {
				if (draft === null) return;
				const next = draft.enabled !== true;
				setDraft({ ...draft, enabled: next });
				commit({ enabled: next });
			}
			/** Flip 高级设置. Collapsed stays the default on every mount. */
			function toggleAdvanced() {
				setAdvancedOpen((previous) => !previous);
			}
			/** Reveal / re-mask the key box. Nothing is written either way. */
			function toggleKeyReveal() {
				setKeyReveal((previous) => !previous);
			}
			/**
			 * Switch the judge source. A select-on-click control, like the enable switch:
			 * the host answers with the effective values, so the card never shows a choice
			 * the host refused. Both sources are always pickable — the JEV branch is where
			 * its connection is filled in, so it cannot need that connection to be picked.
			 */
			function chooseBackend(next) {
				if (draft === null || backend === next) return;
				commit({ backend: next });
			}
			const advancedBodyId = "dsh-cursor-modes-settings-advanced";
			const on = draft !== null && draft.enabled === true;
			// The judge source, normalized here rather than trusted: one bad stored value
			// must not take the card down with it.
			const backend = judgeBackendOf(draft);
			const keyConfigured = view?.apiKeyConfigured === true;
			const values = draft === null ? {} : draft;
			// The footer's summary names only what the branch actually reads: the timeout on
			// both, and the two measured thresholds on the decision model's branch.
			const summary = [
				t("settings.summaryTimeout") + " " + values.timeoutMs + " ms",
				backend === "jev" ? t("settings.summaryAllow") + " " + values.allowConfidence : null,
				backend === "jev" ? t("settings.summaryWorkReject") + " " + values.workReject : null
			].filter((part) => part !== null).join(" · ");
			const advancedFields = GATE_FIELDS.filter((field) => field.jevOnly !== true || backend === "jev");
			// Row 1 is the whole header: the title, the sentence that explains the switch,
			// and the switch itself on the right, aligned with the title line rather than
			// floated into the middle of the paragraph.
			const headRow = react.createElement("div", {
				className: settings.row + " " + settings.rowTop,
				key: "head"
			},
				react.createElement("div", { className: settings.info, key: "info" },
					react.createElement("div", { className: settings.title, key: "title" }, t("settings.title")),
					react.createElement("div", { className: settings.hint, key: "desc" }, descNodes(t("settings.desc")))),
				react.createElement("button", {
					type: "button",
					key: "switch",
					className: on ? settings.switch + " " + settings.switchOn : settings.switch,
					role: "switch",
					"aria-checked": on,
					"aria-label": t("settings.enabled"),
					title: t("settings.enabled") + "：" + (on ? t("settings.on") : t("settings.off")),
					disabled: busy || draft === null,
					onClick: toggleEnabled
				}, react.createElement("span", {
					className: settings.knob,
					"aria-hidden": true,
					key: "knob"
				})));
			// --- 判官来源: one segmented control, 跟随当前模型 on the left, no caption line ---
			const sourceRow = react.createElement("div", { className: settings.row, key: "source" },
				react.createElement("div", { className: settings.info, key: "info" },
					react.createElement("div", { className: settings.label, key: "label" }, t("settings.source"))),
				react.createElement("div", {
					className: settings.seg,
					role: "group",
					"aria-label": t("settings.source"),
					key: "seg"
				},
					react.createElement("button", {
						type: "button",
						key: "follow",
						className: backend === "llm" ? settings.segBtn + " " + settings.segOn : settings.segBtn + " " + settings.segOff,
						"aria-pressed": backend === "llm",
						disabled: busy,
						onClick: () => chooseBackend("llm")
					}, t("settings.sourceFollow")),
					react.createElement("button", {
						type: "button",
						key: "jev",
						className: backend === "jev" ? settings.segBtn + " " + settings.segOn : settings.segBtn + " " + settings.segOff,
						"aria-pressed": backend === "jev",
						disabled: busy,
						onClick: () => chooseBackend("jev")
					}, t("settings.sourceJev"))));
			// --- 判官模型 (follow branch only): the session's model, stated, not chosen ---
			const modelRow = backend !== "llm" ? null : react.createElement("div", { className: settings.row, key: "model" },
				react.createElement("div", { className: settings.info, key: "info" },
					react.createElement("div", { className: settings.label, key: "label" }, t("settings.model"))),
				react.createElement("div", {
					className: settings.selectRow + " " + settings.selectFixed,
					key: "control",
					title: t("settings.modelFollowHint"),
					"aria-description": t("settings.modelFollowHint")
				},
					react.createElement("span", { className: settings.selectText, key: "text" }, t("settings.modelFollowSession")),
					react.createElement("span", {
						className: settings.selectHint,
						"aria-hidden": true,
						key: "chevron"
					}, "▾")));
			// --- 高级设置: the numbers the chosen judge reads, and the JEV-only pair ---
			const advancedBlock = !advancedOpen ? null : backend === "jev"
				? react.createElement("div", {
					className: settings.grid,
					id: advancedBodyId,
					key: "advancedFields"
				}, advancedFields.map((field) => react.createElement("label", {
					className: settings.cell,
					key: field.key
				},
					react.createElement("span", { className: settings.cellLabel, key: "label" }, t(field.label)),
					react.createElement("span", { className: settings.cellHint, key: "hint" }, t(field.hint)),
					react.createElement("input", {
						className: settings.input + " " + settings.inputWide,
						type: field.type,
						step: field.step,
						min: field.min,
						max: field.max,
						"aria-label": t(field.label),
						value: String(draft[field.key] ?? ""),
						disabled: busy,
						onChange: (event) => edit(field.key, event.target.value),
						onBlur: () => saveField(field)
					}))))
				: react.createElement("div", {
					className: settings.fields,
					id: advancedBodyId,
					key: "advancedFields"
				}, advancedFields.map((field) => react.createElement("label", {
					className: settings.field,
					key: field.key
				},
					react.createElement("span", { className: settings.fieldText, key: "text" },
						react.createElement("span", { className: settings.fieldLabel, key: "label" }, t(field.label)),
						react.createElement("span", { className: settings.fieldHint, key: "hint" }, t(field.hint))),
					react.createElement("input", {
						className: settings.input,
						type: field.type,
						step: field.step,
						min: field.min,
						max: field.max,
						"aria-label": t(field.label),
						value: String(draft[field.key] ?? ""),
						disabled: busy,
						onChange: (event) => edit(field.key, event.target.value),
						onBlur: () => saveField(field)
					}))));
			// --- ruled footer: 高级设置, and the numbers it hides while shut ---
			const foot = draft === null ? null : react.createElement("button", {
				type: "button",
				key: "foot",
				className: settings.row + " " + settings.foot,
				"aria-expanded": advancedOpen,
				"aria-controls": advancedBodyId,
				onClick: toggleAdvanced
			},
				react.createElement("span", { className: settings.advancedLabel, key: "label" }, t("settings.advanced")),
				react.createElement("span", { className: settings.summary, key: "summary" }, summary + " " + (advancedOpen ? "▴" : "▸")));
			/**
			 * One connection row. The key's box is a password field until 显示 is pressed,
			 * and its placeholder says whether a key is stored — the value itself is never
			 * sent down, and an empty box means "keep it".
			 */
			function connectionRow(field) {
				const value = String(draft === null ? "" : draft[field.key] ?? "");
				if (field.key === "apiKey") {
					return react.createElement("label", { className: settings.row, key: field.key },
						react.createElement("div", { className: settings.info, key: "info" },
							react.createElement("div", { className: settings.label, key: "label" }, t(field.label)),
							react.createElement("div", { className: settings.hint, key: "hint" }, t(field.hint))),
						react.createElement("div", { className: settings.control + " " + settings.controlRow, key: "control" },
							react.createElement("input", {
								className: settings.input,
								type: keyReveal ? "text" : "password",
								"aria-label": t(field.label),
								placeholder: t(keyConfigured ? "settings.apiKeySaved" : "settings.apiKeyPlaceholder"),
								autoComplete: "off",
								spellCheck: false,
								value,
								disabled: busy,
								onChange: (event) => edit(field.key, event.target.value),
								onBlur: () => saveConnection(field)
							}),
							react.createElement("button", {
								type: "button",
								key: "reveal",
								className: settings.reveal,
								"aria-pressed": keyReveal,
								disabled: busy,
								onClick: toggleKeyReveal
							}, t(keyReveal ? "settings.hide" : "settings.show"))));
				}
				return react.createElement("label", { className: settings.row, key: field.key },
					react.createElement("div", { className: settings.info, key: "info" },
						react.createElement("div", { className: settings.label, key: "label" }, t(field.label)),
						react.createElement("div", { className: settings.hint, key: "hint" }, t(field.hint))),
					react.createElement("input", {
						className: settings.input,
						type: "text",
						"aria-label": t(field.label),
						placeholder: field.placeholder,
						autoComplete: "off",
						spellCheck: false,
						value,
						disabled: busy,
						onChange: (event) => edit(field.key, event.target.value),
						onBlur: () => saveConnection(field)
					}));
			}
			const children = [headRow];
			if (view === null || draft === null) {
				children.push(react.createElement("div", {
					className: settings.error,
					role: "alert",
					key: "state"
				}, error ?? t("settings.loading")));
			} else {
				children.push(sourceRow);
				if (modelRow !== null) children.push(modelRow);
				if (foot !== null) children.push(foot);
				if (advancedBlock !== null) children.push(advancedBlock);
				// The connection group: JEV only, after the advanced block, so the card reads
				// top-down as source → what the judge reads → where the judge lives.
				if (backend === "jev") {
					children.push(react.createElement("div", { className: settings.groupHead, key: "connectionHead" },
						react.createElement("span", { className: settings.groupLabel, key: "label" }, t("settings.connection"))));
					for (const field of CONNECTION_FIELDS) children.push(connectionRow(field));
				}
				if (error !== null) {
					children.push(react.createElement("div", {
						className: settings.error,
						role: "alert",
						key: "error"
					}, error));
				}
			}
			return react.createElement("section", {
				className: settings.card,
				"data-cursor-modes-settings": "1"
			}, ...children);
		}
		//#endregion
		//#region dsh-cursor-modes/ModeSwitch.module.css
		// The chip metrics are copied from the shipped permission control
		// (PermissionSelect.module.css): 28px row, secondary label color, 220px max
		// width, ellipsised label, 24px radius. The staged pending choice, if any, overrides the label:
		// it marks a choice that has been made but not yet sent.
		const chipCss = ".dms_trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:6px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}.dms_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dms_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.dms_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.dms_label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.dms_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;display:inline-flex}.dms_chevronOpen{transform:rotate(180deg)}.dms_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}";
		const chipTagId = "dsh-cursor-modes/ModeSwitch.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(chipTagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-cursor-modes";
			tag.dataset.pluginCss = chipTagId;
			tag.textContent = chipCss;
			document.head.appendChild(tag);
		}
		const styles = {
			trigger: "dms_trigger",
			label: "dms_label",
			chevron: "dms_chevron",
			chevronOpen: "dms_chevronOpen",
			error: "dms_error"
		};
		//#endregion
		//#region dsh-cursor-modes/modes
		/**
		 * Menu order, which is also the mutual-exclusion order. The chip only ever
		 * records a choice in this vocabulary: nothing here executes a command.
		 */
		const MODE_IDS = [
			"default",
			"cursorPlan",
			"cursorMulti"
		];
		/**
		 * Reduce the host projections to the mode the session has committed to.
		 *
		 * The merged plugin registers exactly ONE projection, key `mode`, whose
		 * wire view is `{ mode: "default" | "plan" | "multi", pending: boolean }`
		 * (lib/projection.js modeView). The old second key is gone with the old
		 * plugins: there is no separate plan projection to fold.
		 *
		 * The official `plan` projection still outranks it — when the harness's own
		 * plan mode is on the chip must say Cursor Plan, whatever the merged latch
		 * has caught up to.
		 *
		 * @param projections - the projection values, by key.
		 * @returns the committed mode id.
		 */
		function currentMode(projections) {
			if (projections.plan === true || projections.plan?.mode === "plan") return "cursorPlan";
			const m = projections.mode?.mode;
			if (m === "plan") return "cursorPlan";
			if (m === "multi") return "cursorMulti";
			return "default";
		}
		/**
		 * The chip's pending override: the staged choice only shows while it differs
		 * from what the session already commits to, so a choice the host has since
		 * applied stops looking pending instead of needing to be cleared here.
		 * @param committed - the committed mode id.
		 * @param staged - the locally staged mode id, or null.
		 * @returns the mode to show, and whether it is a pending override.
		 */
		function pendingOverride(committed, staged) {
			if (staged === null || staged === committed) return null;
			return staged;
		}
		//#endregion
		//#region dsh-cursor-modes/pending
		/**
		 * The host half's pending-selection bridge: two loopback-only POST paths
		 * that only remember a choice (lib/routes.js, BRIDGE_PREFIX from
		 * lib/switch.js). Same shape as the settings card's bridge above.
		 */
		const PENDING_BRIDGE = "/api/dsh-cursor-modes/switch";
		/** POST one bridge path; every answer is JSON, refusals included. */
		const post = async (path, body) => {
			const response = await fetch(PENDING_BRIDGE + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			return response.json();
		};
		/** Per-session pending selections, keyed by session identity. */
		const selections = new Map();
		/**
		 * One session's pending mode selection. Everything here is local: a click
		 * or a keyboard pick changes this object and tells the host half what the
		 * pending choice is, and nothing else — no command, no session event, no
		 * conversation entry. The host applies the net change at the send itself.
		 *
		 * @param sessionId - the session the chip belongs to.
		 * @param transport - the bridge call, injected for the self-check.
		 * @returns the selection handle the chip component renders.
		 */
		function createSelection(sessionId, transport = post) {
			let staged = null;
			/** The committed mode the current pending choice was recorded against. */
			let against = null;
			let failure = null;
			const listeners = new Set();
			const notify = () => {
				for (const listener of [...listeners]) listener();
			};
			const settle = (call) => call.then(() => {}, (reason) => {
				failure = reason instanceof Error ? reason.message : String(reason);
				notify();
			});
			/** Retract the pending choice, the host copy included. */
			const clear = () => {
				staged = null;
				against = null;
				failure = null;
				notify();
				return settle(transport("/clear", { sessionId }));
			};
			return {
				read: () => staged,
				failure: () => failure,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				stage: (next) => {
					if (MODE_IDS.indexOf(next) < 0) throw new Error("unknown mode: " + next);
					staged = next;
					against = null;
					failure = null;
					notify();
					return settle(transport("/stage", {
						sessionId,
						target: next
					}));
				},
				clear,
				/**
				 * Reconcile the pending choice with the mode the host commits to. A choice
				 * the host already resolved must not outlive it: the host drops its own copy
				 * at the send that applies it (lib/index.js:612), and a mode switched by any
				 * other route - the plan card's Build button stages on the host bridge
				 * directly (createBuild, this file's buildButtons region) - leaves this map holding a
				 * choice the host will never apply, which would resurface as a phantom
				 * override on the next mode change.
				 * @param committed - the mode the projections currently fold to.
				 */
				reconcile: (committed) => {
					if (staged === null) return;
					if (committed === staged) {
						staged = null;
						against = null;
						notify();
						return;
					}
					if (against === null) {
						against = committed;
						return;
					}
					if (committed !== against) void clear();
				}
			};
		}
		/** The stable selection handle of one session. */
		function selectionFor(sessionId) {
			let found = selections.get(sessionId);
			if (found === undefined) {
				found = createSelection(sessionId);
				selections.set(sessionId, found);
			}
			return found;
		}
		//#endregion
		//#region dsh-cursor-modes/ModeSwitch chip
		/**
		 * Mode control beside the permission control: a 28px chip naming the mode
		 * that opens the three mutually exclusive modes. The shown mode is the
		 * committed one plus the local pending override, and a pending choice that
		 * differs from the committed one overrides the label.
		 *
		 * Two projections are read: the merged `mode` one (committed latch) and
		 * the official `plan` one (which outranks it). The third read the retired
		 * plugin had — its own plan projection — died with that plugin.
		 */
		function ModeSwitch({ useProjection, selection, t }) {
			const plan = useProjection("plan");
			const mode = useProjection("mode");
			const [open, setOpen] = react.useState(false);
			const [, bump] = react.useState(0);
			react.useEffect(() => selection.subscribe(() => bump((revision) => revision + 1)), [selection]);
			const staged = selection.read();
			const committed = currentMode({
				plan,
				mode
			});
			// Every hook stays above the early return, and a pending choice the host has
			// already resolved is retired before the label can read it as an override.
			react.useEffect(() => {
				selection.reconcile(committed);
			}, [committed, staged, selection]);
			if (plan === undefined && mode === undefined) return null;
			const pending = pendingOverride(committed, staged);
			const shown = pending === null ? committed : pending;
			const label = t("chip.mode." + shown);
			const failure = selection.failure();
			/**
			 * A pick is a local edit only. Returning to the committed mode retracts
			 * the pending choice instead of staging it: the host would compute the
			 * same empty net change, and the chip should stop showing the pending choice.
			 */
			const choose = (id) => {
				setOpen(false);
				if (id === shown) return;
				if (id === committed) selection.clear();
				else selection.stage(id);
			};
			return react.createElement(react.Fragment, null, react.createElement(primitives.Menu, {
				open,
				items: MODE_IDS.map((id) => ({
					id,
					label: t("chip.mode." + id)
				})),
				selectedId: shown,
				onSelect: choose,
				onClose: () => {
					setOpen(false);
				},
				side: "top",
				portal: true,
				anchor: react.createElement("button", {
					type: "button",
					className: styles.trigger,
					"aria-label": t("chip.control.aria", { name: label }),
					title: t("chip.control.title"),
					"aria-haspopup": "menu",
					"aria-expanded": open,
					onClick: () => {
						setOpen(!open);
					},
					children: [
						react.createElement("span", {
							key: "label",
							className: styles.label,
							children: label
						}),
						react.createElement("span", {
							key: "chevron",
							className: open ? styles.chevron + " " + styles.chevronOpen : styles.chevron,
							"aria-hidden": true,
							children: react.createElement(primitives.IconChevronDownOutlineRegular, {})
						})
					]
				})
			}), failure !== null && react.createElement("span", {
				key: "error",
				className: styles.error,
				role: "status",
				title: failure,
				children: t("chip.stageFailed")
			}));
		}
		//#endregion
		//#region dsh-cursor-modes/locales
		/**
		 * `cursorModes` namespace dictionaries: the two retired namespaces
		 * (`cursorPlan` and `modeSwitch`) merged into one, keys grouped by the
		 * seat that reads them — `card.*` for the Created Plan card, `settings.*`
		 * for the gate card (the tab label reuses `settings.title`), `chip.*` for
		 * the mode control. One NS means one register call and one bound `t`.
		 */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			// —— card.*: the Created Plan turnTail card
			"card.eyebrow": "已创建计划",
			"card.expand": "展开全文",
			"card.collapse": "收起",
			"card.view": "View Plan",
			"card.buildMulti": "Build in Multi",
			"card.buildDefault": "Build in Default",
			"card.copy": "复制",
			"card.copied": "已复制",
			"card.footnotes": "脚注",
			"card.buildFailed": "开始执行失败",
			// —— settings.*: the delegation-gate card in 设置 → 插件
			"settings.title": "委派门禁",
			"settings.tabLabel": "Cursor Plan 委派门禁",
			"settings.desc": "打开后，计划模式下的 \x60subagent\x60 / \x60send_message\x60 委派、以及需要你点确认的操作，都先交给判官判定；判官拿不准再问你。改动即时生效。",
			"settings.enabled": "委派门禁",
			"settings.on": "已启用",
			"settings.off": "已关闭",
			"settings.source": "判官来源",
			"settings.sourceFollow": "跟随当前模型",
			"settings.sourceJev": "JEV 专用判官",
			"settings.model": "判官模型",
			"settings.modelFollowSession": "跟随当前会话模型",
			"settings.modelFollowHint": "用当前会话的模型判定",
			"settings.advanced": "高级设置",
			"settings.timeout": "判官超时（毫秒）",
			"settings.timeoutHint": "超过就按拦截处理",
			"settings.allowConfidence": "放行置信度",
			"settings.allowConfidenceHint": "0–1，越高越严",
			"settings.workReject": "改动概率上限",
			"settings.workRejectHint": "0–1，越低越严",
			"settings.summaryTimeout": "超时",
			"settings.summaryAllow": "放行阈值",
			"settings.summaryWorkReject": "改动上限",
			"settings.connection": "连接",
			"settings.modelId": "模型 ID",
			"settings.modelIdHint": "网关里模型的名字",
			"settings.baseUrl": "API 地址",
			"settings.baseUrlHint": "留空用本地网关默认",
			"settings.baseUrlInvalid": "这里要填 http(s) 地址",
			"settings.apiKey": "密钥",
			"settings.apiKeyHint": "明文存进插件配置，不回显",
			"settings.apiKeyPlaceholder": "粘贴密钥",
			"settings.apiKeySaved": "已保存，留空不改",
			"settings.show": "显示",
			"settings.hide": "隐藏",
			"settings.numberInvalid": "这里要填数字",
			"settings.loading": "读取中…",
			"settings.unavailable": "设置不可用",
			"settings.saveFailed": "保存失败",
			// —— chip.*: the mode chip beside the permission control
			"chip.mode.default": "default",
			"chip.mode.cursorPlan": "Cursor Plan",
			"chip.mode.cursorMulti": "Cursor Multi",
			"chip.control.aria": "切换模式：{name}",
			"chip.control.title": "切换模式（默认 / Cursor Plan / Cursor Multi）",
			"chip.stageFailed": "待定选择未送达宿主"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			// —— card.*: the Created Plan turnTail card
			"card.eyebrow": "Created Plan",
			"card.expand": "Show full plan",
			"card.collapse": "Collapse",
			"card.view": "View Plan",
			"card.buildMulti": "Build in Multi",
			"card.buildDefault": "Build in Default",
			"card.copy": "Copy",
			"card.copied": "Copied",
			"card.footnotes": "Footnotes",
			"card.buildFailed": "Failed to start building",
			// —— settings.*: the delegation-gate card in 设置 → 插件
			"settings.title": "Delegation gate",
			"settings.tabLabel": "Cursor Plan delegation gate",
			"settings.desc": "While on, \x60subagent\x60 / \x60send_message\x60 delegations in plan mode, and the actions that wait for your confirmation, go to the judge first; when the judge is unsure it asks you. Edits apply immediately.",
			"settings.enabled": "Delegation gate",
			"settings.on": "on",
			"settings.off": "off",
			"settings.source": "Judge source",
			"settings.sourceFollow": "Use current model",
			"settings.sourceJev": "Dedicated JEV judge",
			"settings.model": "Judge model",
			"settings.modelFollowSession": "Follow the current session model",
			"settings.modelFollowHint": "Judged by this session's own model",
			"settings.advanced": "Advanced",
			"settings.timeout": "Judge timeout (ms)",
			"settings.timeoutHint": "Past it the call is denied (ms)",
			"settings.allowConfidence": "Allow confidence",
			"settings.allowConfidenceHint": "0–1, higher is stricter",
			"settings.workReject": "Change-probability cap",
			"settings.workRejectHint": "0–1, lower is stricter",
			"settings.summaryTimeout": "timeout",
			"settings.summaryAllow": "allow threshold",
			"settings.summaryWorkReject": "change cap",
			"settings.connection": "Connection",
			"settings.modelId": "Model ID",
			"settings.modelIdHint": "The model name in your gateway",
			"settings.baseUrl": "API address",
			"settings.baseUrlHint": "Empty uses the local gateway default",
			"settings.baseUrlInvalid": "Needs an http(s) address",
			"settings.apiKey": "API key",
			"settings.apiKeyHint": "Plain text in the plugin config, never echoed",
			"settings.apiKeyPlaceholder": "Paste the key",
			"settings.apiKeySaved": "Saved — leave empty to keep it",
			"settings.show": "Show",
			"settings.hide": "Hide",
			"settings.numberInvalid": "A number goes here",
			"settings.loading": "loading…",
			"settings.unavailable": "settings unavailable",
			"settings.saveFailed": "save failed",
			// —— chip.*: the mode chip beside the permission control
			"chip.mode.default": "default",
			"chip.mode.cursorPlan": "Cursor Plan",
			"chip.mode.cursorMulti": "Cursor Multi",
			"chip.control.aria": "Switch mode: {name}",
			"chip.control.title": "Switch mode (Default / Cursor Plan / Cursor Multi)",
			"chip.stageFailed": "The pending selection did not reach the host"
		};
		//#endregion
		//#region dsh-cursor-modes/subagent-copy
		/**
		 * Session-header subagent chip copy (moved here from dsh-colombia-skin 0.2.2, where it
		 * started life as a skin tweak; the responsibility travels with this plugin now).
		 *
		 * The chip renders "{n} 个子智能体" (locale ns "subagent", count.total.*) as its VISIBLE
		 * text in every state. DSH announces a running subagent through the chip button
		 * aria-label ("{n} 个子智能体，正在运行" = count.running.*, n = the RUNNING count) plus a
		 * spinner, while the visible text stays at the TOTAL. So this reads that aria-label:
		 * running -> visible text "<runningCount> 个子智能体正在运行" (count taken from the aria,
		 * never from the visible total), idle -> "累计 <total> 个子智能体". With no recognizable
		 * chip aria it falls back to rewriting by wording alone. Digits are always Arabic. The
		 * locale registry is single-owner (register() throws on an existing (ns, locale)), hence
		 * post-render rewriting. Keyed on wording and on the chip own aria-label — never on
		 * hashed class names. Idempotent: every output re-parses to the same count and re-emits
		 * unchanged, and a write happens only on a real change, so the MutationObserver cannot
		 * loop.
		 * ponytail: the running state is read from DSH aria phrasing — if DSH re-words it this
		 * falls back to the 累计 text silently.
		 */
		const SUBAGENT_BASE_COPY = /^(\d+)\s*个子智能体$/;
		const SUBAGENT_ACCUM_COPY = /^累计\s*(\d+)\s*个子智能体$/;
		const SUBAGENT_RUNNING_COPY = /^(\d+)\s*个子智能体(?:，正在运行|正在运行)$/;
		const SUBAGENT_ARIA_COPY = /^(\d+)\s*个子智能体(，正在运行)?$/;
		function subagentChipCopy(node) {
			const el = node && (node.nodeType === 1 ? node : node.parentElement);
			if (!el || typeof el.closest !== "function") return null;
			const chip = el.closest("button[aria-label]");
			if (!chip) return null;
			const aria = (chip.getAttribute("aria-label") || "").trim();
			const m = SUBAGENT_ARIA_COPY.exec(aria);
			if (!m) return null;
			return { running: /正在运行$/.test(aria), count: m[1] };
		}
		function rewriteSubagentText(node) {
			const value = (node.nodeValue || "").trim();
			if (!value) return;
			const base = SUBAGENT_BASE_COPY.exec(value);
			const accum = base === null ? SUBAGENT_ACCUM_COPY.exec(value) : null;
			const runningText = base === null && accum === null ? SUBAGENT_RUNNING_COPY.exec(value) : null;
			if (base === null && accum === null && runningText === null) return;
			const chip = subagentChipCopy(node);
			const count = chip !== null ? chip.count : base !== null ? base[1] : accum !== null ? accum[1] : runningText[1];
			const running = chip !== null ? chip.running : runningText !== null;
			const next = running ? count + " 个子智能体正在运行" : "累计 " + count + " 个子智能体";
			if (next !== node.nodeValue) node.nodeValue = next;
		}
		function rewriteSubagentCopy(node) {
			if (!node) return;
			if (node.nodeType === 3) { rewriteSubagentText(node); return; }
			if (node.nodeType !== 1) return;
			const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
			for (let text = walker.nextNode(); text; text = walker.nextNode()) rewriteSubagentText(text);
		}
		/** One initial pass plus the observer; returns the disposer the plugin effect needs. */
		function mountSubagentCopy() {
			// No document = a headless harness (the self-checks eval this module in Node); nothing to observe.
			if (typeof document === "undefined") return () => {};
			rewriteSubagentCopy(document.body);
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					if (record.type === "characterData" || record.type === "attributes") { rewriteSubagentCopy(record.target); continue; }
					for (const added of record.addedNodes) rewriteSubagentCopy(added);
					const target = record.target;
					// the spinner span is REMOVED when a run ends, so re-check the chip button itself too
					if (target && target.nodeType === 1 && typeof target.matches === "function" && target.matches("button[aria-label]")) rewriteSubagentCopy(target);
				}
			});
			observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
			return () => observer.disconnect();
		}
		//#endregion
		//#region dsh-cursor-modes/subagent-panel
		/**
		 * Session-header subagent dropdown compaction. Moved here from dsh-colombia-skin 0.2.2,
		 * where it shipped as a skin tweak; the skin keeps only the card LOOK now, and this plugin
		 * owns the fold. Nothing here reads a skin variable, so an instance without the skin still
		 * gets a usable card.
		 *
		 * DSH renders the dropdown as a [role="tree"] whose rows are [role="treeitem"][aria-level];
		 * a row that is RUNNING carries [data-state="ongoing"] (the StateDot) and no other row does.
		 * While >=1 top-level row runs, the idle and finished top-level rows are collapsed
		 * (attribute data-dcm-collapsed -> display:none) and a short button is pinned right below the
		 * last running row: centred arrow + "展开更多". Clicking it (then "收起" + the flipped arrow)
		 * reveals or hides the rest. No running row, or every row running -> the panel is left
		 * exactly as DSH rendered it. Every reopen starts collapsed: the expanded flag is dropped
		 * whenever the [role="tree"] node goes away or is replaced, so nothing is remembered. All
		 * writes are guarded (an attribute is set only when it differs, the card is moved only when
		 * it is not already in place), so the MutationObserver replay cannot self-oscillate.
		 *
		 * ponytail: this rides DSH's DOM contract ([role=tree] / [role=treeitem] / aria-level /
		 * data-state=ongoing) instead of hashed class names; if DSH changes that contract the card
		 * simply stops appearing - tools/panel_state_probe.cjs is the check that turns red. Only
		 * TOP-LEVEL rows drive it: a running grandchild under an idle parent leaves the panel alone.
		 */
		/**
		 * The card's own sheet. `[data-dcm-collapsed]` is FUNCTIONAL - without it the fold does
		 * nothing - and the rest is the no-skin baseline: a plain button on DSH's own tokens. A skin
		 * overrides it (dsh-colombia-skin does, through a `body .dcm-expand-more` rule of higher
		 * specificity, so sheet order never decides who wins).
		 */
		const DCM_PANEL_CSS = "/* dsh-cursor-modes: the fold is functional, the button is the no-skin baseline. */" +
			"[data-dcm-collapsed]{display:none!important}" +
			".dcm-expand-more{display:flex;align-items:center;justify-content:center;gap:6px;" +
			"width:100%;height:30px;margin:2px 0;padding:0 7px 0 9px;" +
			"border:0;border-radius:7px;background:transparent;color:inherit;" +
			"font:inherit;font-size:12px;cursor:pointer}" +
			".dcm-expand-more:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
			".dcm-expand-more:focus-visible{outline:1px solid var(--dsw-alias-border-l2);outline-offset:-1px}" +
			".dcm-expand-more svg{flex:0 0 auto;opacity:.9}";
		let dcmExpanded = false;
		let dcmRoot = null;
		let dcmCard = null;            // the ONE card this plugin owns; never rebuilt per pass
		let dcmBodyObserver = null;
		let dcmRootObserver = null;
		let dcmScheduled = 0;          // pending rAF/timeout handle -> at most one pass per frame
		let dcmSyncing = false;        // reentrancy guard: a pass may never re-enter itself
		let dcmSig = "";               // signature of the last APPLIED state
		let dcmStopped = false;        // circuit-breaker latch
		let dcmSyncTimes = [];         // rolling 1s window of pass timestamps
		let dcmSyncs = 0;
		let dcmWrites = 0;
		let dcmNoopStreak = 0;
		const DCM_RATE_CAP = 30;       // passes per rolling second before the breaker trips
		const DCM_NOOP_CAP = 300;      // consecutive no-change passes before the breaker trips

		/** Counters the probes read (tools/panel_state_probe.cjs, panel_stress_probe.cjs). */
		function dcmStats() {
			return { syncs: dcmSyncs, writes: dcmWrites, stopped: dcmStopped, expanded: dcmExpanded, noop: dcmNoopStreak, card: !!dcmCard };
		}
		/** Whoa, too much churn: latch off, drop the card, say so once. */
		function dcmStop(reason) {
			if (dcmStopped) return;
			dcmStopped = true;
			try { if (dcmRootObserver) dcmRootObserver.disconnect(); } catch {}
			try { if (dcmBodyObserver) dcmBodyObserver.disconnect(); } catch {}
			dcmRootObserver = null;
			dcmBodyObserver = null;
			dcmRemoveCards();
			console.warn("[dsh-cursor-modes] subagent compaction stopped: " + reason);
		}

		/* --- every write compares the current value first: a pass that changes nothing writes nothing --- */
		function dcmSetAttr(el, name, value) {
			if (!el || el.getAttribute(name) === value) return 0;
			el.setAttribute(name, value);
			return 1;
		}
		function dcmDropAttr(el, name) {
			if (!el || !el.hasAttribute(name)) return 0;
			el.removeAttribute(name);
			return 1;
		}
		function dcmSetText(el, value) {
			if (!el || el.textContent === value) return 0;
			el.textContent = value;
			return 1;
		}

		/* --- our own nodes: their creation/move is never a reason to resync (that was the loop) --- */
		function dcmOwnNode(node) {
			if (!node || node.nodeType !== 1) return false;
			if (node.hasAttribute && node.hasAttribute("data-dcm-expand-more")) return true;
			if (node.closest && node.closest("[data-dcm-expand-more]")) return true;
			if (node.matches && node.matches("style[data-dcm-panel-css]")) return true;
			return false;
		}
		function dcmIsRow(node) {
			return !!(node && node.nodeType === 1 && node.matches && node.matches('[role="treeitem"][aria-level]'));
		}
		function dcmIsTree(node) {
			return !!(node && node.nodeType === 1 && node.matches && node.matches('[role="tree"]'));
		}
		/* Cheap relevance filter: the app re-renders constantly; only dropdown-shaped churn schedules a pass. */
		function dcmRelevant(node) {
			if (!node || node.nodeType !== 1) return false;
			if (dcmOwnNode(node)) return false;
			if (dcmIsTree(node) || dcmIsRow(node)) return true;
			if (node.querySelector && node.querySelector('[role="treeitem"][aria-level]')) return true;
			if (dcmRoot && node.contains && node.contains(dcmRoot)) return true;
			return false;
		}
		function dcmDefer(fn) {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return setTimeout(fn, 16);
			if (typeof requestAnimationFrame === "function") return requestAnimationFrame(fn);
			return setTimeout(fn, 16);
		}
		/* Coalesce every request inside one frame into a single pass. */
		function dcmScheduleSync() {
			if (dcmStopped || dcmScheduled) return;
			dcmScheduled = dcmDefer(function () {
				dcmScheduled = 0;
				dcmSync();
			});
		}

		/* Observer 1 - document.body, childList ONLY. No attributes: an unfiltered attribute
		   observer re-enters the sync on every React write anywhere in the app, and the sync
		   writes DOM. Records about our own card / sheet are dropped before a pass is scheduled. */
		function dcmOnBodyMutations(records) {
			if (dcmStopped) return;
			for (let i = 0; i < records.length; i += 1) {
				const rec = records[i];
				for (let j = 0; j < rec.addedNodes.length; j += 1) if (dcmRelevant(rec.addedNodes[j])) { dcmScheduleSync(); return; }
				for (let j = 0; j < rec.removedNodes.length; j += 1) if (dcmRelevant(rec.removedNodes[j])) { dcmScheduleSync(); return; }
			}
		}

		/* Observer 2 - the panel root only, and only for the StateDot's data-state (plus row churn).
		   attributeFilter excludes data-dcm-collapsed, so our own writes can never come back in. */
		function dcmOnRootMutations(records) {
			if (dcmStopped) return;
			for (let i = 0; i < records.length; i += 1) {
				const rec = records[i];
				if (rec.type === "attributes") { dcmScheduleSync(); return; }
				let own = true;
				for (let j = 0; j < rec.addedNodes.length && own; j += 1) if (!dcmOwnNode(rec.addedNodes[j])) own = false;
				for (let j = 0; j < rec.removedNodes.length && own; j += 1) if (!dcmOwnNode(rec.removedNodes[j])) own = false;
				if (!own) { dcmScheduleSync(); return; }
			}
		}

		function dcmPanelRoots() {
			// the sidebar is [role="tree"] too, and it comes first: only trees carrying aria-level rows
			// are subagent dropdowns, and the dropdown is the last one of those.
			const roots = Array.prototype.slice.call(document.querySelectorAll('[role="tree"]'));
			const leveled = roots.filter((root) => root.querySelector('[role="treeitem"][aria-level]'));
			return leveled.length ? leveled : roots;
		}
		function dcmPanelRows(root) {
			return Array.prototype.slice.call(root.querySelectorAll('[role="treeitem"][aria-level]'));
		}
		function dcmRowRunning(row) {
			return !!row.querySelector('[data-state="ongoing"]');
		}
		function dcmCards() {
			return Array.prototype.slice.call(document.querySelectorAll("[data-dcm-expand-more]"));
		}
		function dcmEnsureCss() {
			if (document.querySelector("style[data-dcm-panel-css]")) return;
			const el = document.createElement("style");
			el.setAttribute("data-dcm-panel-css", "1");
			el.textContent = DCM_PANEL_CSS;
			document.head.appendChild(el);
		}
		function dcmCardElement() {
			const card = document.createElement("button");
			card.type = "button";
			card.className = "dcm-expand-more";
			card.setAttribute("data-dcm-expand-more", "1");
			// ponytail: innerHTML is written HERE and nowhere else - the card is built once and only
			// its label/arrow are ever touched afterwards (rebuilding it every pass was part of the freeze).
			card.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6l4 4 4-4"></path></svg><span class="dcm-expand-more-text"></span>';
			return card;
		}
		function dcmRenderCard(card, expanded) {
			let writes = 0;
			writes += dcmSetText(card.querySelector(".dcm-expand-more-text"), expanded ? "收起" : "展开更多");
			writes += dcmSetAttr(card, "aria-label", expanded ? "收起子智能体列表" : "展开更多子智能体");
			writes += dcmSetAttr(card, "aria-expanded", expanded ? "true" : "false");
			const path = card.querySelector("path");
			if (path) {
				const transform = expanded ? "rotate(180 8 8)" : "";
				writes += transform ? dcmSetAttr(path, "transform", transform) : dcmDropAttr(path, "transform");
			}
			return writes;
		}
		function dcmRemoveCards() {
			dcmCards().forEach((card) => card.remove());
			dcmCard = null;
		}

		function dcmSyncPass() {
			dcmSyncs += 1;
			const now = Date.now();
			dcmSyncTimes.push(now);
			while (dcmSyncTimes.length && now - dcmSyncTimes[0] > 1000) dcmSyncTimes.shift();
			if (dcmSyncTimes.length > DCM_RATE_CAP) {
				dcmStop("more than " + DCM_RATE_CAP + " passes in one second - refusing to thrash the main thread");
				return;
			}

			const roots = dcmPanelRoots();
			if (!roots.length) {
				if (dcmRootObserver) { dcmRootObserver.disconnect(); dcmRootObserver = null; }
				dcmRoot = null;
				dcmExpanded = false;
				dcmSig = "";
				dcmRemoveCards();
				return;
			}
			const root = roots[roots.length - 1];
			if (root !== dcmRoot) {
				dcmRoot = root;
				dcmExpanded = false;   // every reopen starts collapsed: nothing is remembered
				dcmSig = "";
				if (dcmRootObserver) dcmRootObserver.disconnect();
				dcmRootObserver = new MutationObserver(dcmOnRootMutations);
				dcmRootObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
			}
			dcmCards().forEach((card) => {
				if (!root.contains(card)) { card.remove(); if (dcmCard === card) dcmCard = null; }
			});

			const rows = dcmPanelRows(root);
			if (!rows.length) return;
			let minLevel = Infinity;
			rows.forEach((row) => {
				const level = parseInt(row.getAttribute("aria-level"), 10);
				if (!isNaN(level) && level < minLevel) minLevel = level;
			});
			if (!isFinite(minLevel)) minLevel = 1;
			const top = rows.filter((row) => parseInt(row.getAttribute("aria-level"), 10) === minLevel);
			const running = top.filter(dcmRowRunning);
			const idle = top.filter((row) => !dcmRowRunning(row));
			const collapse = running.length > 0 && idle.length > 0;
			const hideIdle = collapse && !dcmExpanded;
			const anchor = collapse ? (running[running.length - 1].parentElement || running[running.length - 1]) : null;
			const host = anchor ? anchor.parentElement : null;

			let collapsedNow = 0;
			idle.forEach((row) => {
				const box = row.parentElement || row;
				if (box.hasAttribute("data-dcm-collapsed")) collapsedNow += 1;
			});
			const cardOk = !!dcmCard && document.contains(dcmCard) && host !== null &&
				dcmCard.parentElement === host && dcmCard.previousElementSibling === anchor;
			const sig = [collapse, hideIdle, dcmExpanded, cardOk, collapsedNow, top.length, running.length, idle.length].join("|");
			if (sig === dcmSig) {
				// nothing to write this pass: do not touch the DOM at all (an unwritten pass cannot re-enter)
				dcmNoopStreak += 1;
				if (dcmNoopStreak > DCM_NOOP_CAP) dcmStop(DCM_NOOP_CAP + " passes with no state change");
				return;
			}
			dcmNoopStreak = 0;

			let writes = 0;
			idle.forEach((row) => {
				const box = row.parentElement || row;
				writes += hideIdle ? dcmSetAttr(box, "data-dcm-collapsed", "1") : dcmDropAttr(box, "data-dcm-collapsed");
			});
			if (!collapse) {
				if (dcmCards().length) { dcmRemoveCards(); writes += 1; }
			} else if (host && anchor) {
				let card = dcmCard;
				if (!card || !document.contains(card) || !root.contains(card)) {
					card = dcmCards().filter((node) => root.contains(node))[0] || null;
				}
				if (!card) { card = dcmCardElement(); writes += 1; }   // created ONCE, then reused
				dcmCard = card;
				if (card.parentElement !== host || card.previousElementSibling !== anchor) {
					host.insertBefore(card, anchor.nextSibling);
					writes += 1;
				}
				writes += dcmRenderCard(card, dcmExpanded);
			}
			dcmWrites += writes;
			dcmSig = sig;
		}

		function dcmSync() {
			if (dcmStopped || dcmSyncing) return;
			dcmSyncing = true;
			try { dcmSyncPass(); } finally { dcmSyncing = false; }
		}
		function dcmCardClick(event) {
			const target = event.target;
			const card = target && target.closest ? target.closest("[data-dcm-expand-more]") : null;
			if (!card) return;
			event.preventDefault();
			event.stopPropagation();
			dcmExpanded = !dcmExpanded;
			dcmSync();
		}
		/** One initial pass plus the observers; returns the disposer the plugin effect needs. */
		function mountSubagentCompact() {
			if (typeof document === "undefined") return () => {};
			if (dcmStopped || dcmBodyObserver) return () => {};
			dcmEnsureCss();
			if (typeof window !== "undefined") window.__dcmPanelStats = dcmStats;
			dcmSig = "";
			dcmSync();
			document.addEventListener("click", dcmCardClick, true);
			dcmBodyObserver = new MutationObserver(dcmOnBodyMutations);
			dcmBodyObserver.observe(document.body, { childList: true, subtree: true });
			return () => {
				dcmStopped = true;
				try { if (dcmRootObserver) dcmRootObserver.disconnect(); } catch {}
				try { if (dcmBodyObserver) dcmBodyObserver.disconnect(); } catch {}
				dcmRootObserver = null;
				dcmBodyObserver = null;
				if (typeof document !== "undefined") document.removeEventListener("click", dcmCardClick, true);
				dcmRemoveCards();
				dcmRoot = null;
				const sheet = document.querySelector("style[data-dcm-panel-css]");
				if (sheet) sheet.remove();
				if (typeof window !== "undefined" && window.__dcmPanelStats === dcmStats) delete window.__dcmPanelStats;
			};
		}
		//#endregion
		//#region dsh-cursor-modes/index
		/** Dictionary namespace owned by this plugin. */
		const NS = "cursorModes";
		/**
		 * Required services: slot registry, conversation events, locale. Deliberately
		 * no commands Remote — a pick must never execute a command
		 * (dsh-commands/lib/index.js:327-351 logs every execution, and the
		 * conversation renders those rows). Same rule for the Created Plan card's
		 * two Build buttons: they go through the loopback bridges, never a command,
		 * because every resolved execution appends `command/run` + `command/done`
		 * and the conversation renders that pair as a persistent receipt — the storm
		 * the mode control exists to avoid.
		 */
		const inject = [
			"slots",
			"uiConversation",
			"locale"
		];
		/**
		 * Client plugin body: Created Plan on turnTail (after the closing reply) with
		 * its two Build buttons, the delegation-gate card in the plugins settings
		 * tab, and the mode chip in the composer's left tool row. No toolview card —
		 * that seat folds into turn-process and hides the plan after the turn
		 * settles.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-cursor-modes: dictionaries");
			/** Lookup for the settings tab label; components get their own `t` from the slot. */
			const t = ctx.locale.bind(NS);
			ctx.uiConversation.events.register(createPlanDefinition);
			// The switch notice is a durable `user/message` whose source is this
			// plugin's own kind. The shipped projection files it under `context`,
			// which chat-visibility hides, so this Definition re-projects it as a
			// visible row and the keyed renderer below owns that row.
			ctx.uiConversation.events.register(switchNoticeDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: SWITCH_NOTICE_NODE_KIND,
				locale: NS
			}, SwitchNoticeLine));
			// turnTail is a list slot: the registration needs its own `id`, and
			// PlanCard declines the turns it has no plan for.
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				id: "cursor-modes",
				locale: NS,
				// Session scope: the slot calls inject with the session id, so the card
				// wraps this session's build action and never closes over an undefined
				// owner field. Both Build buttons come from the client's own helper:
				// stage the target mode on the pending bridge, then write the one
				// message on this plugin's build bridge. No command, so no receipt.
				inject: (sessionId) => ({ buildPlan: createBuild(sessionId) })
			}, PlanCard));
			// The built-in plugins section hosts one tab per id in
			// `settings.plugins.tab`. The host serves the `cursor-modes` settings
			// namespace (lib/gate-settings.js GATE_SETTINGS_NS); the card's own reads
			// and writes go through the loopback bridge.
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "cursor-modes",
				order: 20,
				label: () => t("settings.tabLabel"),
				locale: NS
			}, CursorPlanSettingsCard));
			// Session-header subagent chip copy: a post-render text rewrite, because the
			// locale dictionary is single-owner. Disposed with the plugin.
			ctx.effect(() => mountSubagentCopy(), "dsh-cursor-modes: subagent chip copy");
			// Session-header subagent dropdown: while something runs only the running rows stay
			// visible, plus a "展开更多" card that reveals the rest. Pure DOM - the dropdown is
			// not a React node this plugin owns - and disposed with the plugin.
			ctx.effect(() => mountSubagentCompact(), "dsh-cursor-modes: subagent panel compaction");
			// The composer's left tool row: the mode chip renders immediately right
			// of the permission control.
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "mode-chip",
				locale: NS,
				inject: (sessionId) => ({ selection: selectionFor(sessionId) })
			}, ModeSwitch));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		// ponytail: the pure halves are exported only so the self-checks can drive
		// them without a browser; the running page never reads them.
		exports.MODE_IDS = MODE_IDS;
		exports.currentMode = currentMode;
		exports.pendingOverride = pendingOverride;
		exports.createSelection = createSelection;
		exports.BUILD_TARGETS = BUILD_TARGETS;
		exports.createBuild = createBuild;
		exports.MODE_BRIDGE = MODE_BRIDGE;
		exports.BUILD_BRIDGE = BUILD_BRIDGE;
		exports.PENDING_BRIDGE = PENDING_BRIDGE;
		exports.locales = { zh, en };
		// The card's pure helpers, exported for self-check-settings-ui.mjs: the
		// address rule and the row list are asserted directly instead of through a
		// render, because both are rules, not tree shapes.
		exports.gateCardHelpers = { normalizeBaseUrl, baseUrlProblem, GATE_FIELDS, CONNECTION_FIELDS, DEFAULT_BASE_URL };
		return module.exports;
	}
});
