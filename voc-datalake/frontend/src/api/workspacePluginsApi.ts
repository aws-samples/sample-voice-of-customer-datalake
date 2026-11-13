/**
 * @fileoverview The current workspace's plugins (`/me/workspaces/current/plugins`; lambda/api/workspaces_handler.py,
 * lambda/shared/workspace_plugin_settings.py, docs/multi-workspace.md → Per-workspace configuration).
 *
 * The list is every plugin the deployment offers (its ceiling), in the server's order, with whether this workspace
 * enabled it; any member reads it. Only a workspace admin turns one on or off: enabling writes the workspace's
 * `PLUGIN#` row (the plugin's scheduled runs then collect into the workspace, and its Run now there runs), disabling
 * deletes it. Every call names the workspace in `X-Workspace-Id` (api/baseUrl.ts). The list is
 * read leniently: a row this build cannot read is left out.
 *
 * @module api/workspacePluginsApi
 */
import { z } from 'zod'
import { fetchApi } from './client'
import { put } from './requestKit'

const PluginSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  enabled_at: z.string().optional().catch(undefined),
  enabled_by: z.string().optional().catch(undefined),
})
export type WorkspacePlugin = z.infer<typeof PluginSchema>

const ListSchema = z.object({ plugins: z.array(z.unknown()) })
const ChangeSchema = z.object({ plugin: PluginSchema })

/** The rows of a `GET /me/workspaces/current/plugins` answer this build can read, in the server's order. */
export function readWorkspacePlugins(raw: unknown): WorkspacePlugin[] {
  const parsed = ListSchema.safeParse(raw)
  if (!parsed.success) return []
  return parsed.data.plugins.flatMap((row) => {
    const plugin = PluginSchema.safeParse(row)
    return plugin.success ? [plugin.data] : []
  })
}

/**
 * One workspace's plugins, under the caller's workspaces' root, in the `standard` family (a sub-key in
 * api/queryPolicies.ts: other admins change it).
 */
export const workspacePluginsKey = (workspaceId: string) => ['my-workspaces', 'plugins', workspaceId] as const

// Each path is written out in full, so the route audit (scripts/audit/py_route_callers.py) reads it as the caller.
export const workspacePluginsApi = {
  list: async (): Promise<WorkspacePlugin[]> => readWorkspacePlugins(await fetchApi<unknown>('/me/workspaces/current/plugins')),
  /** Workspace admins only; its refusals are workspaceRefusals.ts `PLUGIN_REFUSALS`. */
  setEnabled: async (pluginId: string, enabled: boolean): Promise<WorkspacePlugin> =>
    ChangeSchema.parse(await fetchApi<unknown>(`/me/workspaces/current/plugins/${encodeURIComponent(pluginId)}`, put({ enabled }))).plugin,
}
