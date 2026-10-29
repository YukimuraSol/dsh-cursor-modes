/**
 * `list_running_agent`: the identity-only view of the subagent tree.
 *
 * 0.2.1 shipped this tool by patching it straight into the vendored official
 * `@deepseek-ai/dsh-tool-subagent-control` (lib/types/list-agents.js). That is
 * the wrong owner: the file is not ours, an upgrade silently drops it, and a
 * bug in it cannot be attributed. The official file is restored byte-for-byte to
 * its upstream shape and the tool lives here instead — same name, same schema,
 * same copy, so the model cannot tell the difference.
 *
 * Why a separate tool at all, when `list_agents` already reports status: a
 * coordinator with sixteen children only ever asks "which are still working?",
 * and `list_agents` answers with the full tree it then has to filter. This one
 * filters in the plugin.
 *
 * Registration is a plain `defineTool` on the host's registry, mounted from the
 * same inject group the modes use (see lib/index.js). The live Agent registry is
 * read per call through `host.get('agents')` rather than added to the inject
 * list: needing it must not stop the modes from mounting on a host that exposes
 * no agent registry.
 *
 * @module dsh-cursor-modes/list-running-agent
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/** The only status this tool reports: it never returns an idle child. */
const RUNNING = 'running';

/** Whether the live registry says this child is executing a turn right now. */
const isRunning = (agents, id) => agents?.get?.(id)?.status === RUNNING;

/**
 * Register `list_running_agent`.
 * @param host - the inject-group host: `tools`, `subagents`, and (read per call)
 *   the live `agents` registry.
 */
export function registerListRunningAgent(host) {
	host.tools.register(defineTool({
		name: 'list_running_agent',
		description: 'List only the subagents that are running right now, with their ids and labels. Use it instead of list_agents when many children have accumulated: finished children and every non-identity field are omitted, so the answer stays small. '
			+ 'A running child is also announced to you when it finishes, so treat this as a cheap progress glance rather than a polling loop. '
			+ 'Use list_agents when you need inactive children or the full tree.',
		parameters: {
			include_descendants: {
				type: 'boolean',
				description: 'false (default) lists only your direct running children. true lists every running descendant and adds its parent id and depth.'
			}
		},
		output: {
			schema: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: { type: 'string', required: true },
						label: { type: 'string', required: true },
						status: { type: 'string', required: true, enum: ['running'] },
						parent: { type: 'string' },
						depth: { type: 'number' }
					}
				}
			},
			render: (args, entries) => [{
				type: 'text',
				text: entries.length === 0
					? '(no running subagents)'
					: entries.map((entry) => args.include_descendants === true
						? `${entry.id} — ${entry.label} parent=${String(entry.parent)} depth=${String(entry.depth)}`
						: `${entry.id} — ${entry.label}`).join('\n')
			}]
		},
		execute: async (args, exec) => {
			const parent = exec.agent;
			if (!parent) {
				throw new Error('list_running_agent requires a calling agent (exec.agent was undefined)');
			}
			const agents = host.get?.('agents');
			if (agents === undefined) {
				throw new Error('list_running_agent requires the live Agent registry');
			}
			// The tree is the authority on identity; the registry only answers "is it
			// executing a turn right now". A resident but idle child is what
			// `list_agents` already reports, and diagnostics add noise here.
			const entries = args.include_descendants === true
				? await host.subagents.listDescendants(parent.id, exec.signal)
				: await host.subagents.listChildren(parent.id, exec.signal);
			return entries
				.filter((entry) => !('kind' in entry && entry.kind === 'diagnostic'))
				.filter((entry) => isRunning(agents, entry.id))
				.map((entry) => ({
					id: entry.id,
					label: entry.label ?? '(no label)',
					status: RUNNING,
					...('depth' in entry ? { parent: entry.parentId, depth: entry.depth } : {})
				}));
		}
	}));
}
