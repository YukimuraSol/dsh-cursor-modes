# dsh-cursor-modes

Cursor-like mode switching for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — plan / execute modes, a judge-backed **delegation gate**, and per-mode tool policy, all driven from the Web UI.

## What it does

- **Mode switchers** — switch the session between plan-style and execute-style modes without editing config.
- **Delegation gate** — before a subagent is dispatched, a judge decides whether the task is read-only or not, and either allows it or blocks it. Fail-closed: a judge that cannot answer blocks the dispatch.
- **Two gate backends** — follow the current session model, or point at a dedicated decision model (e.g. a local gateway).
- **Plan mode** — persistent plan cards with an execution checklist.
- **Per-mode tool policy** — the tool catalog changes with the mode; prompts are kept stable for request-cache reuse.
- **Multitask mode** — a quota-gated delegation mode: the main thread hands work to background agents and asks for more quota with `request_more_edits` when it runs out.
- **Checklist handover** — `subagent` and `subagent_fork` take a `todos` argument, and the child is told its starting checklist exactly once, in its first turn.
- **`list_running_agent`** — a small companion to `list_agents` that lists only the children still running, so a parent with many finished children keeps a short answer.

## What's new in 0.2.1

- The approved checklist reaches the model **once**, as the opening notice of the turn the build starts — not as a per-step mirror of the UI's todo state. An unchanged list costs nothing; a changed one is a normal `todo_write`, not a new injected snapshot.
- `list_running_agent` is registered by this plugin. It used to be patched into `@deepseek-ai/dsh-tool-subagent-control`, which any upgrade would have silently removed.

## Install

**From the Web UI** — Settings → Plugins → Add plugin, and paste either:

```
https://github.com/YukimuraSol/dsh-cursor-modes
```

or the package name, if you installed it from npm.

**From the CLI**

```bash
dsh plugin --profile <your-profile> add https://github.com/YukimuraSol/dsh-cursor-modes
```

Restart the instance afterwards — the Host half loads at boot.

## Requirements

- DeepSeek Harness with a `web` profile (the client half is a Web UI plugin).
- Node 20+.

The `@deepseek-ai/*` packages are supplied by the DSH installation itself and are declared as optional peers, so no second copy is installed.

## Notes

- The gate is **fail-closed** by design: if the judge is unreachable or answers ambiguously, the dispatch is blocked rather than allowed.
- The gate stores its connection settings (model id, base URL, key) in the plugin config. The key is never echoed back to the UI.

## License

MIT
