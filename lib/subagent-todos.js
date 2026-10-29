// dsh-cursor-modes - subagent `todos` handover (Host half).
//
// A delegation can hand its child a starting plan: the parent passes `todos` to
// the subagent tool and the child's own todo state begins with that list instead
// of an empty one. This used to live as a hand edit to two official packages
// (@deepseek-ai/dsh-tool-subagent and @deepseek-ai/dsh-subagent), which is erased
// by the next upgrade and invisible to the profile. The same behaviour is rebuilt
// here from outside, on two public extension points.
//
// WHERE IT LIVES NOW: this file is the standalone `dsh-subagent-todos` 0.1.0
// host module, moved verbatim into `dsh-cursor-modes` 0.2.1 so one package owns
// the capability that `lib/build.js` and the task policy already ask the model
// for. `lib/index.js` mounts it from inside the same inject group the modes use:
//
//   tools/change       - the one that decides what step 1 sees (only listener)
//   agent/pre-step     - a SECOND listener beside the modes' own; both call
//                        `next()` first and this one only touches the tool
//                        definition, so registration order cannot change either
//                        outcome (the modes' listener stays outermost)
//   agent/created      - no other listener in this package
//   tools/post-execute - a SECOND listener beside the modes' own; it returns
//                        `next()` untouched, so the modes' additionalContexts
//                        channel still owns the decision
//
// The idempotence marker below is the SAME `Symbol.for` key the standalone
// package used, so a profile that still mounts that package cannot append the
// description tail twice while both are live.
//
// THREE LINKS, and each one is why the previous link cannot do the job alone.
//
// 1. The tool has no `todos` parameter in the official build, so the model cannot
//    even name it. It is added to the live tool definition at `agent/created`, and
//    re-checked on every `agent/pre-step`. Writing the definition is safe because
//    defineTool keeps `parameters` as a PLAIN object and `Tools.schemas()` /
//    `sdkSchemas()` deep-copy it per assembly; that same object is what the tool's
//    own argument validator closes over, so the added property is accepted, not
//    merely advertised. See patchDefinition().
//
//    WHY THE REGISTRATION HOOK IS THE LOAD-BEARING ONE (measured on 4000, not
//    assumed): the AgentLoop assembles the prompt BEFORE it runs the
//    `agent/pre-step` waterfall, and under PTC the model-facing schema IS that
//    assembly's SDK declaration. So a pre-step patch first appears on step 2 -
//    too late for the one-step delegation that needs it. `agent/created` is not
//    early enough either: the delegation tool is registered into the agent's
//    scope AFTER the announcement, so at `agent/created` it is not visible yet.
//    The tool runtime emits `tools/change` on every layer change, which is the
//    first moment the definition exists and still precedes the first assembly.
//    Both earlier hooks are kept as cheap nets (idempotent, one boolean each).
//
// 2. The list itself has to reach the child. It is appended as the child's own
//    `todo/write` event, not as a parent-side note: the todo projection is the
//    child's, and only an event on the child session populates it.
//
// 3. The append must happen INSIDE the child's first turn. The todo projection
//    clears on `turn/start`, so anything appended during setup (before the
//    child's first turn opens) is discarded. `agent/pre-step` with a
//    `kind === 'enter'` decision runs after turn/start and before the first
//    request - the only window that works, and the same one the harness's own
//    descriptor uses.
//
// WHY THE HANDOVER IS EXACT, with no heuristics: `tools/post-execute` receives
// BOTH the call (`exec.arguments.todos`) and the result
// (`result.value.subagentId`) in one frame, so the list is bound to the child id
// the runtime actually created. No (parent, label) guessing.
//
// WHY IT CANNOT DEADLOCK: `agent/created` fires inside the parent's `execute`
// (during materialize(), before the prompt is submitted) and the AgentLoop holds
// the child's input until the serial listeners return. The parent's call then
// returns the child id, so its post-execute lands while the child's first step is
// held. The child waits on nothing the parent waits for; the timeout bounds a
// handover that should never happen, it is not a delay.

/**
 * Kept for shape compatibility with the standalone `dsh-subagent-todos` module
 * this file was moved from. The loader mounts rows for `lib/index.js`; nothing
 * reads this export now that the capability ships inside `dsh-cursor-modes`.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { renderChecklist } from './prompts.js'

export const name = 'dsh-subagent-todos'

/**
 * Private marker on the patched tool definition.
 *
 * A Symbol, not a string key: `Tools.schemaOf` projects `parameters` through a
 * lossless JSON copy, and a marker on the definition (never inside
 * `parameters`) cannot leak into the model-facing schema or the request-header
 * comparison.
 */
const PATCHED = Symbol.for('dsh-subagent-todos.patched')

/** Sentence appended once to the tool description. */
const DESCRIPTION_TAIL =
  ' Pass `todos` only when the work has a clear plan flow: a handful of ordered'
  + ' steps you will actually track. Skip the parameter for a single-step errand.'

/** Whether the description tail is already present. */
const DESCRIPTION_MARK = 'Pass `todos` only when the work has a clear plan flow'

/** Model-facing description of the added parameter. */
const TODOS_DESCRIPTION =
  "The child's starting todo list. Every item is recorded in the child's own todo"
  + ' state as it starts, so it begins with this plan instead of an empty one.'
  + ' Omit to start with no list; the child\'s own `todo_write` later replaces the'
  + ' list wholesale, which is normal.'

/** How long a child's first step may wait for the handover. */
const DEFAULT_CLAIM_TIMEOUT_MS = 5000

/** The three statuses the todo projection accepts. */
const STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * Every delegation tool that accepts a starting plan.
 *
 * Both official tools are one mount of the same code with a different provider
 * and tool name, and BOTH return `{ kind: 'activation', subagentId }` and create
 * their child the same way (source `startup`, session origin `subagent`), so the
 * handover below is identical for the two. `subagent_fork` is listed because the
 * hand edit this replaces covered it too: leaving it out would be a silent
 * regression, not a scope decision.
 */
const TOOL_NAMES = ['subagent', 'subagent_fork']

/**
 * Canonicalise a model-supplied todo list.
 *
 * Mirrors the `initialTodos` validator the hand edit shipped: trim every content,
 * drop duplicates, default a missing status to `pending`. Two deliberate
 * differences, both about failure ownership: an empty or duplicate item is
 * DROPPED instead of thrown, because this runs inside the parent's post-execute
 * where throwing would turn a usable delegation into a failed call, and an empty
 * result is reported as "no list" rather than as an empty one.
 * @param raw - whatever the call supplied under `todos`.
 * @returns canonical `{ content, status }` items, or undefined when there is none.
 */
export function normalize(raw) {
  if (!Array.isArray(raw)) return undefined
  const todos = []
  const seen = new Set()
  for (const item of raw) {
    const content = String(item?.content ?? '').trim()
    if (content.length === 0 || seen.has(content)) continue
    seen.add(content)
    const status = item?.status
    todos.push({ content, status: STATUSES.has(status) ? status : 'pending' })
  }
  return todos.length === 0 ? undefined : todos
}

/**
 * Add the `todos` parameter and its guidance sentence to one live tool definition.
 *
 * Idempotent, and cheap enough to call on every step: the marker makes a repeat
 * call a single boolean read. Both halves are guarded separately, so a definition
 * that already declared `todos` for some other reason keeps its own wording and
 * only gains the marker.
 * @param definition - the live ToolDefinition for the delegation tool.
 * @returns true when this call actually changed the definition.
 */
export function patchDefinition(definition) {
  if (definition === null || typeof definition !== 'object') return false
  if (definition[PATCHED] === true) return false
  const properties = definition.parameters?.properties
  if (properties === null || typeof properties !== 'object') return false
  let changed = false
  if (!Object.hasOwn(properties, 'todos')) {
    properties.todos = {
      type: 'array',
      description: TODOS_DESCRIPTION,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['content'],
        properties: {
          content: {
            type: 'string',
            description: 'What the task is - a short imperative line.',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
            description: 'pending (not started) | in_progress (now) | completed (done). Defaults to pending.',
          },
        },
      },
    }
    changed = true
  }
  if (typeof definition.description === 'string' && !definition.description.includes(DESCRIPTION_MARK)) {
    definition.description += DESCRIPTION_TAIL
    changed = true
  }
  definition[PATCHED] = true
  return changed
}

/**
 * Mount the three links.
 * @param ctx - Host plugin context.
 * @param config - `{ claimTimeoutMs }`, all optional.
 */
export function apply(ctx, config) {
  const timeout = Number.isFinite(config?.claimTimeoutMs) && config.claimTimeoutMs > 0
    ? config.claimTimeoutMs
    : DEFAULT_CLAIM_TIMEOUT_MS

  /** child id -> latch for a child that has not taken its first step yet. */
  const latches = new Map()
  /**
   * child id -> `{ todos }` for a handover that arrived before the child's
   * `agent/created` announcement. The runtime's order makes this impossible today,
   * so it is insurance - and it is what makes the two orderings testable.
   */
  const early = new Map()

  /**
   * Write one canonical list into a child's own todo state.
   * @param agent - the child agent.
   * @param todos - canonical items.
   */
  function appendTodos(agent, todos) {
    try {
      agent.session.append('todo/write', {
        todos: todos.map((todo) => ({ content: todo.content, status: todo.status })),
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-cursor-modes: subagent-todos: could not seed the child todo list: ' + String(error))
    }
  }

  /**
   * Arm the handover latch for one freshly created child.
   *
   * The latch settles exactly once: by the parent's call, or by a decision that
   * there is nothing to hand over (`offer(undefined)` - a real answer, and the one
   * that keeps a child with no `todos` from waiting out the timeout). Its only
   * consumer is the child's first `enter` step, which then stops watching.
   * @param agent - the child agent.
   * @returns the latch, so an early handover can be replayed into it.
   */
  function armLatch(agent) {
    const childId = agent.id
    let settled = false
    let todos
    let notify = null
    let taken = false

    /**
     * One-shot: accept the handover, or record that there is none.
     * @param list - canonical items, or undefined when the call carried none.
     */
    function offer(list) {
      if (settled) return
      settled = true
      todos = list
      notify?.()
    }

    const off = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (taken) return decision
      taken = true
      // Stop watching this child now, but keep the latch REACHABLE until it
      // settles: the handover routinely arrives while this very step is held,
      // so unregistering here would lose it and leave the step to time out.
      try { off?.() } catch { /* already disposed with the child */ }
      if (decision?.kind !== 'enter') {
        latches.delete(childId)
        return decision
      }
      if (!settled) {
        const delivered = await new Promise((resolve) => {
          let timer
          const settle = (value) => {
            if (timer !== undefined) clearTimeout(timer)
            notify = null
            resolve(value)
          }
          notify = () => settle(true)
          timer = setTimeout(() => settle(false), timeout)
          // The bound must not hold the process open for an idle session.
          timer?.unref?.()
          // A handover that raced this promise is not lost.
          if (settled) settle(true)
        })
        if (!delivered) {
          ctx.logger?.debug?.(
            'dsh-cursor-modes: subagent-todos: child ' + childId + ' started without a todo handover within '
            + String(timeout) + 'ms; continuing with no seeded list',
          )
          latches.delete(childId)
          return decision
        }
      }
      // Settled, written or empty: the child is decided and the entry can go, so a
      // long session cannot hold one latch per child.
      latches.delete(childId)
      if (todos === undefined) return decision
      appendTodos(agent, todos)
      // The child reads its checklist ONCE, in its first turn, and never again:
      // this is a handover notice, not a mirror of the kernel's `todos`
      // projection (which is UI state and resets on every `turn/start`).
      const text = renderChecklist(todos)
      if (text === '') return decision
      const checklist = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'dsh-cursor-modes', form: 'notice', summary: 'Handed-over checklist' },
      })
      const messages = Array.isArray(decision?.messages) ? decision.messages : []
      return { ...decision, messages: [...messages, checklist] }
    })

    return { offer }
  }

  /**
   * Patch one agent's view of the delegation tool, containing every failure.
   * @param agent - the agent whose definition should carry the parameter.
   */
  function patchAgent(agent) {
    try {
      if (agent === undefined || agent === null) return
      const tools = ctx.get?.('tools')
      for (const toolName of TOOL_NAMES) {
        const definition = tools?.get(toolName, agent)
        if (definition === undefined) continue
        if (patchDefinition(definition)) {
          ctx.logger?.info?.(
            'dsh-cursor-modes: subagent-todos: todos parameter added to ' + toolName + ' for agent ' + String(agent.id),
          )
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-cursor-modes: subagent-todos: could not patch the delegation tool schema: ' + String(error))
    }
  }

  // (a) The tool definition, in three passes that escalate in urgency:
  //
  //   tools/change  THE one that decides what the model sees on step 1. The
  //                 delegation tool is registered into the agent's scope after
  //                 the announcement, and registration is what this fires on,
  //                 which is still before the first prompt assembly.
  //   agent/created keeps an agent that gained its tools before the announcement
  //                 correct without waiting for the next registration.
  //   agent/pre-step the net under both, and always forwarded (waterfall).
  ctx.on('tools/change', () => {
    for (const agent of ctx.get?.('agents')?.list?.() ?? []) patchAgent(agent)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    patchAgent(payload?.agent)
    return next()
  })

  // (b) The latch, armed while the child is still held at creation. Serial
  // dispatch: a throw here would fail the whole delegation, so it is contained.
  // Fork children reach this the same way (source `startup`, origin `subagent`):
  // the fork provider only supplies a seed for `agents.create`, it does not
  // resume a session, so no fork-specific branch is needed.
  ctx.on('agent/created', (payload) => {
    try {
      patchAgent(payload?.agent)
      if (payload?.source !== 'startup') return
      const agent = payload.agent
      if (agent?.session?.header?.origin !== 'subagent') return
      if (agent.id === undefined || latches.has(agent.id)) return
      const latch = armLatch(agent)
      latches.set(agent.id, latch)
      if (early.has(agent.id)) {
        const handed = early.get(agent.id)
        early.delete(agent.id)
        latch.offer(handed.todos)
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-cursor-modes: subagent-todos: could not arm the todo handover: ' + String(error))
    }
  })

  // (c) The handover. Call and result in one frame: the list is bound to the
  // child id the runtime actually created.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (TOOL_NAMES.includes(exec?.name) && result?.value?.kind === 'activation') {
        const childId = result.value.subagentId
        if (childId !== undefined) {
          const todos = normalize(exec.arguments?.todos)
          const latch = latches.get(childId)
          if (latch !== undefined) latch.offer(todos)
          else early.set(childId, { todos })
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-cursor-modes: subagent-todos: could not hand the todo list to the child: ' + String(error))
    }
    return next()
  })

  // A plugin mounted into a profile that already has live agents would otherwise
  // wait for the next announcement, so patch the current ones once here.
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) patchAgent(agent)
}
