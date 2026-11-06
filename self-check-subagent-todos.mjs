/**
 * dsh-cursor-modes - subagent `todos` handover self-check.
 *
 * Moved here with the module it tests (it used to be `dsh-subagent-todos`' own
 * self-check). The only change is the import path: the host logic is
 * `lib/subagent-todos.js` now, mounted by `lib/index.js`, so this file imports
 * the module directly and every assertion below is unchanged.
 *
 * Drives the shipped module through the three links it installs, with a fake
 * context that behaves like the parts of Cordis it touches (a waterfall, a
 * serial emit, a disposer-returning listener registration). Nothing here leans
 * on a live Harness: every claim below is about the plugin's own logic.
 *
 *   1. the schema patch is idempotent and projects into the model-facing copy;
 *   2. the handover works in both orders (call last, call first);
 *   3. a call WITH NO list settles the child at once - it must not become a
 *      timeout on every ordinary delegation;
 *   4. the timeout gives up instead of hanging the child's first step;
 *   5. only a startup-created `subagent` child is latched - a main agent and a
 *      resumed session are not;
 *   6. normalize() trims, de-duplicates and defaults status like the standalone
 *      initialTodos() the hand edit shipped.
 *
 * Run: node self-check-subagent-todos.mjs   (exit 0 = pass)
 */
import { apply, normalize, patchDefinition } from './lib/subagent-todos.js'

let checks = 0
let failures = 0
function ok(label, pass, detail) {
  checks += 1
  if (!pass) failures += 1
  console.log((pass ? 'ok   ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}
/** Structural equality on plain JSON. */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}
/** Yield one macrotask, so a pending promise in the plugin gets to run. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A delegation tool definition shaped like the official one (no todos). */
function makeDefinition(name = 'subagent') {
  return {
    name,
    description: 'Start an independent delegation.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', required: true },
        prompt: { type: 'string', required: true },
      },
      required: ['description', 'prompt'],
    },
    output: {},
  }
}

/**
 * A fake host context: records listeners, forwards a waterfall, and serves the
 * one tool lookup the plugin makes.
 * @param definition - the definition `tools.get('subagent')` answers; the fork tool
 *   starts unregistered and a test can add it through `state.definitions`.
 * @param config - plugin config passed to apply().
 */
function makeCtx(definition, config = {}, liveAgents = []) {
  const handlers = new Map()
  const warnings = []
  // Late registration is the real order: the delegation tool appears after the
  // agent does, so the holder starts empty and the test fills it in.
  const state = { definitions: { subagent: definition, subagent_fork: undefined } }
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)), debug() {}, info() {} },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      const list = handlers.get(event)
      list.push(fn)
      return () => {
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
      }
    },
    get(service) {
      if (service === 'agents') return { list: () => liveAgents }
      if (service !== 'tools') return undefined
      return {
        get: (toolName, scope) => (scope === undefined ? undefined : state.definitions[toolName]),
      }
    },
  }
  apply(ctx, config)
  return { ctx, handlers, warnings, state }
}

/**
 * Run one waterfall the way Cordis does: each listener receives the payload
 * arguments plus a `next` that continues the chain.
 */
async function waterfall(handlers, event, args, terminal) {
  const list = [...(handlers.get(event) ?? [])]
  let index = 0
  const next = () => {
    if (index >= list.length) return Promise.resolve(terminal())
    const fn = list[index]
    index += 1
    return Promise.resolve(fn(...args, next))
  }
  return await next()
}

/** Emit a serial event the way Cordis does: every listener, awaited in order. */
async function serial(handlers, event, payload) {
  for (const fn of [...(handlers.get(event) ?? [])]) await fn(payload)
}

/** A fake child agent with its own scoped context and an appendable session. */
function makeChild(id, origin = 'subagent') {
  const handlers = new Map()
  const agent = {
    id,
    session: {
      header: { origin },
      events: [],
      append(type, data) {
        this.events.push({ type, data })
      },
    },
    ctx: {
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, [])
        const list = handlers.get(event)
        list.push(fn)
        return () => {
          const at = list.indexOf(fn)
          if (at >= 0) list.splice(at, 1)
        }
      },
    },
  }
  return { agent, handlers }
}

const ENTER = () => ({ kind: 'enter', messages: [{ type: 'text', text: 'held' }] })

// ---------------------------------------------------------------- 1. schema ---
{
  const definition = makeDefinition()
  ok('patchDefinition reports the first change', patchDefinition(definition) === true)
  ok('patchDefinition reports no second change', patchDefinition(definition) === false)
  ok(
    'patchDefinition declares todos exactly once',
    Object.keys(definition.parameters.properties).filter((key) => key === 'todos').length === 1,
  )
  const todos = definition.parameters.properties.todos
  ok('todos is an array of objects', todos?.type === 'array' && todos.items?.type === 'object', JSON.stringify(todos?.type))
  ok('todos items close their shape', todos.items.additionalProperties === false)
  ok('todos items require content', same(todos.items.required, ['content']))
  ok(
    'todos status is the todo projection enum',
    same(todos.items.properties.status.enum, ['pending', 'in_progress', 'completed']),
  )
  ok(
    'the guidance sentence is appended once',
    definition.description.split('Pass `todos` only when the work has a clear plan flow').length - 1 === 1,
  )
  ok(
    'the description keeps its own original wording',
    definition.description.startsWith('Start an independent delegation.'),
  )
  // schemaOf() deep-copies parameters; the added property must survive the copy.
  const projected = JSON.parse(JSON.stringify(definition.parameters))
  ok('the added parameter survives the model-facing copy', projected.properties.todos?.type === 'array')
  ok(
    'the private marker is a symbol, so the copy cannot carry it',
    Object.getOwnPropertySymbols(definition).length === 1,
  )
}

// The plugin's own pre-step listener patches the definition it is asked for.
{
  const definition = makeDefinition()
  const { handlers } = makeCtx(definition)
  const parent = { id: 'parent-1' }
  await waterfall(handlers, 'agent/pre-step', [{ agent: parent }], ENTER)
  ok('the plugin patches the definition from its pre-step listener', Object.hasOwn(definition.parameters.properties, 'todos'))
  await waterfall(handlers, 'agent/pre-step', [{ agent: parent }], ENTER)
  ok(
    'the plugin stays idempotent across steps',
    Object.keys(definition.parameters.properties).filter((key) => key === 'todos').length === 1,
  )
  ok(
    'the plugin patches nothing for a tool it cannot see',
    patchDefinition({ name: 'other', description: 'x', parameters: { type: 'object' } }) === false,
  )
}

// Ordering, as measured on 4000: the agent is announced BEFORE its delegation
// tool is registered, and the prompt is assembled BEFORE agent/pre-step runs.
// tools/change is therefore the only hook that lands on the first request.
{
  const definition = makeDefinition()
  const live = { id: 'late-agent' }
  const { handlers, state } = makeCtx(undefined, {}, [live])
  ok('nothing is patched while the tool is not registered', !Object.hasOwn(definition.parameters.properties, 'todos'))
  state.definitions.subagent = definition
  await serial(handlers, 'tools/change', {})
  ok(
    'a tool registered after the agent is patched on tools/change',
    Object.hasOwn(definition.parameters.properties, 'todos'),
  )
}
{
  const definition = makeDefinition()
  const { handlers } = makeCtx(definition)
  const main = makeChild('main-agent-2', 'main')
  await serial(handlers, 'agent/created', { agent: main.agent, source: 'startup' })
  ok(
    'an agent whose tools predate the announcement is patched on agent/created',
    Object.hasOwn(definition.parameters.properties, 'todos'),
  )
}
{
  const definition = makeDefinition()
  makeCtx(definition, {}, [{ id: 'live-agent' }])
  ok(
    'an agent that is already live is patched when the plugin mounts',
    Object.hasOwn(definition.parameters.properties, 'todos'),
  )
}

// ------------------------------------------------- 2. handover, call last -----
{
  const { handlers } = makeCtx(makeDefinition())
  const child = makeChild('child-late')
  await serial(handlers, 'agent/created', { agent: child.agent, source: 'startup' })
  const firstStep = waterfall(child.handlers, 'agent/pre-step', [{ agent: child.agent }], ENTER)
  await delay(20)
  ok('the child waits for a handover that has not arrived', child.agent.session.events.length === 0)
  await waterfall(
    handlers,
    'tools/post-execute',
    [
      {
        name: 'subagent',
        arguments: {
          description: 'd',
          prompt: 'p',
          todos: [{ content: '  survey  ' }, { content: 'survey' }, { content: 'write', status: 'completed' }],
        },
      },
      { isError: false, value: { kind: 'activation', subagentId: 'child-late' } },
    ],
    () => ({ kind: 'accept' }),
  )
  await firstStep
  ok(
    'the late handover is trimmed, de-duplicated and status-defaulted',
    same(child.agent.session.events, [
      {
        type: 'todo/write',
        data: { todos: [{ content: 'survey', status: 'pending' }, { content: 'write', status: 'completed' }] },
      },
    ]),
    JSON.stringify(child.agent.session.events),
  )
  // A second step of the same child must not append again.
  await waterfall(child.handlers, 'agent/pre-step', [{ agent: child.agent }], ENTER)
  ok('the seeded list is written once, not once per step', child.agent.session.events.length === 1)
}

// ------------------------------------------------ 3. handover, call first ----
{
  const { handlers } = makeCtx(makeDefinition())
  const child = makeChild('child-early')
  await waterfall(
    handlers,
    'tools/post-execute',
    [
      { name: 'subagent', arguments: { description: 'd', prompt: 'p', todos: [{ content: 'one' }, { content: 'two' }] } },
      { isError: false, value: { kind: 'activation', subagentId: 'child-early' } },
    ],
    () => ({ kind: 'accept' }),
  )
  await serial(handlers, 'agent/created', { agent: child.agent, source: 'startup' })
  const started = Date.now()
  await waterfall(child.handlers, 'agent/pre-step', [{ agent: child.agent }], ENTER)
  ok(
    'an early handover is replayed without waiting',
    Date.now() - started < 200,
    'elapsed=' + String(Date.now() - started) + 'ms',
  )
  ok(
    'the early handover keeps its order',
    same(child.agent.session.events[0]?.data?.todos?.map((todo) => todo.content), ['one', 'two']),
    JSON.stringify(child.agent.session.events),
  )
}

// ------------------------------------ 4. a delegation with no list at all ----
{
  const { handlers } = makeCtx(makeDefinition())
  const child = makeChild('child-plain')
  await serial(handlers, 'agent/created', { agent: child.agent, source: 'startup' })
  const firstStep = waterfall(child.handlers, 'agent/pre-step', [{ agent: child.agent }], ENTER)
  await delay(5)
  const started = Date.now()
  await waterfall(
    handlers,
    'tools/post-execute',
    [
      { name: 'subagent', arguments: { description: 'd', prompt: 'p' } },
      { isError: false, value: { kind: 'activation', subagentId: 'child-plain' } },
    ],
    () => ({ kind: 'accept' }),
  )
  await firstStep
  ok(
    'a call with no todos releases the child at once instead of timing out',
    Date.now() - started < 500,
    'elapsed=' + String(Date.now() - started) + 'ms',
  )
  ok('a call with no todos appends nothing', child.agent.session.events.length === 0)
}

// ------------------------------------------------------------ 5. timeout -----
{
  const { handlers, warnings } = makeCtx(makeDefinition(), { claimTimeoutMs: 60 })
  const child = makeChild('child-timeout')
  await serial(handlers, 'agent/created', { agent: child.agent, source: 'startup' })
  const started = Date.now()
  // The bound is unref'd on purpose (it must never hold the process open), so
  // this test has to keep a referenced timer alive for it to fire at all.
  const keepAlive = setTimeout(() => {}, 1000)
  const decision = await waterfall(child.handlers, 'agent/pre-step', [{ agent: child.agent }], ENTER)
  clearTimeout(keepAlive)
  const elapsed = Date.now() - started
  ok('the timeout gives up instead of hanging', elapsed >= 50 && elapsed < 1000, 'elapsed=' + String(elapsed) + 'ms')
  ok('the step still enters after the timeout', decision?.kind === 'enter')
  ok('the timeout appends nothing', child.agent.session.events.length === 0)
  ok('the timeout leaves no warning for the user', warnings.length === 0, JSON.stringify(warnings))
}

// ------------------------------------------- 6. only startup subagent children
{
  const { handlers } = makeCtx(makeDefinition())
  const main = makeChild('main-agent', 'main')
  await serial(handlers, 'agent/created', { agent: main.agent, source: 'startup' })
  let started = Date.now()
  await waterfall(main.handlers, 'agent/pre-step', [{ agent: main.agent }], ENTER)
  ok('a main agent is not latched', Date.now() - started < 200 && main.handlers.size === 0)

  const resumed = makeChild('child-resume')
  await serial(handlers, 'agent/created', { agent: resumed.agent, source: 'resume' })
  started = Date.now()
  await waterfall(resumed.handlers, 'agent/pre-step', [{ agent: resumed.agent }], ENTER)
  ok('a resumed child is not latched', Date.now() - started < 200 && resumed.handlers.size === 0)

}

// ------------------------------------------------------ 7. subagent_fork ----
// Both delegation tools are one mount of the same code with a different tool
// name and provider, and both answer `{ kind: 'activation', subagentId }`. The
// hand edit this plugin replaces covered BOTH, so covering only `subagent` would
// be a silent regression - these assertions are what stops that.
{
  const forkDefinition = makeDefinition('subagent_fork')
  const subagentDefinition = makeDefinition('subagent')
  const { handlers, state } = makeCtx(subagentDefinition)
  state.definitions.subagent_fork = forkDefinition
  const parent = { id: 'parent-fork' }
  await waterfall(handlers, 'agent/pre-step', [{ agent: parent }], ENTER)
  ok('the fork tool gets the same parameter', Object.hasOwn(forkDefinition.parameters.properties, 'todos'))
  ok(
    'the fork tool gets the same guidance sentence',
    forkDefinition.description.includes('Pass `todos` only when the work has a clear plan flow'),
  )
  ok(
    'both tools carry one todos each',
    Object.keys(forkDefinition.parameters.properties).filter((key) => key === 'todos').length === 1
      && Object.keys(subagentDefinition.parameters.properties).filter((key) => key === 'todos').length === 1,
  )
  await waterfall(handlers, 'agent/pre-step', [{ agent: parent }], ENTER)
  ok(
    'patching both tools stays idempotent',
    forkDefinition.description.split('Pass `todos` only when the work has a clear plan flow').length - 1 === 1,
  )

  // A fork call claims its child exactly like a spawn call does.
  const child = makeChild('child-fork')
  await serial(handlers, 'agent/created', { agent: child.agent, source: 'startup' })
  const firstStep = waterfall(child.handlers, 'agent/pre-step', [{ agent: child.agent }], ENTER)
  await delay(10)
  await waterfall(
    handlers,
    'tools/post-execute',
    [
      { name: 'subagent_fork', arguments: { description: 'd', prompt: 'p', todos: [{ content: 'fork it' }, { content: 'fork it' }, { content: ' report ', status: 'in_progress' }] } },
      { isError: false, value: { kind: 'activation', subagentId: 'child-fork' } },
    ],
    () => ({ kind: 'accept' }),
  )
  await firstStep
  ok(
    'a fork call seeds the child todo list, normalized',
    same(child.agent.session.events, [
      {
        type: 'todo/write',
        data: { todos: [{ content: 'fork it', status: 'pending' }, { content: 'report', status: 'in_progress' }] },
      },
    ]),
    JSON.stringify(child.agent.session.events),
  )
  await waterfall(child.handlers, 'agent/pre-step', [{ agent: child.agent }], ENTER)
  ok('a fork child is seeded once, not once per step', child.agent.session.events.length === 1)
}

// ----------------------------------------------------------- 7. normalize ----
{
  ok('normalize ignores a non-array', normalize(undefined) === undefined && normalize('x') === undefined)
  ok('normalize reports an empty list as no list', normalize([]) === undefined)
  ok('normalize drops items with blank content', normalize([{ content: '   ' }, { content: '\n\t' }]) === undefined)
  ok(
    'normalize trims content',
    same(normalize([{ content: '  a  ' }]), [{ content: 'a', status: 'pending' }]),
    JSON.stringify(normalize([{ content: '  a  ' }])),
  )
  ok(
    'normalize drops duplicate content',
    same(normalize([{ content: 'a' }, { content: ' a ' }, { content: 'b' }]), [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'pending' },
    ]),
  )
  ok(
    'normalize keeps the three known statuses',
    same(
      [
        normalize([{ content: 'a', status: 'pending' }])[0].status,
        normalize([{ content: 'a', status: 'in_progress' }])[0].status,
        normalize([{ content: 'a', status: 'completed' }])[0].status,
      ],
      ['pending', 'in_progress', 'completed'],
    ),
  )
  ok(
    'normalize defaults an unknown status to pending',
    same([normalize([{ content: 'a', status: 'done' }])[0].status, normalize([{ content: 'a' }])[0].status], [
      'pending',
      'pending',
    ]),
  )
}

console.log('')
console.log('checks: ' + String(checks) + ', failures: ' + String(failures))
process.exit(failures === 0 ? 0 : 1)
