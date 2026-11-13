/**
 * @fileoverview The workspace's plugins (`GET /me/workspaces/current/plugins`; docs/multi-workspace.md →
 * Per-workspace configuration): every plugin the deployment offers, in the server's order, and whether this
 * workspace turned it on. Every member reads the list; a workspace admin gets Enable or Disable on each.
 *
 * Enabling a plugin writes the workspace's `PLUGIN#` row (since 7.14.00): the plugin's scheduled runs then collect
 * feedback into this workspace, and Run now in the workspace runs it. Disabling stops both. A refusal (a plugin
 * changed meanwhile, an admin demoted meanwhile, a plugin the deployment stopped offering) is said in words.
 *
 * @module pages/WorkspaceSettings/WorkspacePluginsCard
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Plug } from 'lucide-react'
import clsx from 'clsx'
import Notice from '../../components/Notice/Notice'
import { getPluginManifests } from '../../plugins'
import { usePluginCopy } from '../../plugins/pluginCopy'
import { workspacePluginsApi, workspacePluginsKey } from '../../api/workspacePluginsApi'
import type { WorkspacePlugin } from '../../api/workspacePluginsApi'
import RefusalAlert from '../../workspace/RefusalAlert'
import { PLUGIN_REFUSALS } from '../../workspace/workspaceRefusals'
import { SECTION_TITLE } from '../Settings/sectionTitle'

/** A plugin's name in the UI language: its manifest's copy, else its id (a plugin this build has no manifest for). */
function usePluginName(): (id: string) => string {
  const copyOf = usePluginCopy()
  const manifests = getPluginManifests()
  return (id) => {
    const manifest = manifests.find((candidate) => candidate.id === id)
    return manifest === undefined ? id : copyOf(manifest).name
  }
}

export default function WorkspacePluginsCard({ workspaceId, isAdmin }: Readonly<{ workspaceId: string; isAdmin: boolean }>) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: workspacePluginsKey(workspaceId), queryFn: workspacePluginsApi.list })
  const change = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => workspacePluginsApi.setEnabled(id, enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: workspacePluginsKey(workspaceId) }),
  })
  const nameOf = usePluginName()

  return (
    <section className="card space-y-4" aria-labelledby="workspace-plugins-title">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Plug className="text-accent" size={16} aria-hidden="true" />
          <h2 id="workspace-plugins-title" className={SECTION_TITLE}>{t('workspaces.settings.pluginsTitle')}</h2>
        </div>
        <p className="text-sm text-muted">{t('workspaces.settings.pluginsDescription')}</p>
      </div>
      {isAdmin ? null : <p className="text-sm text-muted">{t('workspaces.settings.pluginsReadOnly')}</p>}
      <RefusalAlert error={change.error} refusals={PLUGIN_REFUSALS} />
      <PluginList query={query} nameOf={nameOf} canManage={isAdmin} busy={change.isPending}
        onChange={(id, enabled) => change.mutate({ id, enabled })} />
    </section>
  )
}

interface PluginListProps {
  readonly query: { data: WorkspacePlugin[] | undefined; isPending: boolean; isError: boolean; refetch: () => unknown }
  readonly nameOf: (id: string) => string
  readonly canManage: boolean
  readonly busy: boolean
  readonly onChange: (id: string, enabled: boolean) => void
}

function PluginList({ query, nameOf, canManage, busy, onChange }: PluginListProps) {
  const { t } = useTranslation()
  if (query.isPending) return <p className="text-sm text-muted" role="status">{t('workspaces.settings.pluginsLoading')}</p>
  if (query.isError || query.data === undefined) {
    return (
      <Notice variant="banner" tone="danger" role="alert" icon={AlertCircle} text={t('workspaces.settings.pluginsLoadFailed')}
        action={{ label: t('workspaces.settings.retry'), onClick: () => void query.refetch() }} />
    )
  }
  if (query.data.length === 0) return <p className="text-sm text-muted">{t('workspaces.settings.pluginsNone')}</p>
  return (
    <ul className="divide-y divide-border" aria-label={t('workspaces.settings.pluginsListLabel')}>
      {query.data.map((plugin) => (
        <PluginRow key={plugin.id} plugin={plugin} name={nameOf(plugin.id)} canManage={canManage} busy={busy}
          onChange={onChange} />
      ))}
    </ul>
  )
}

function PluginRow({ plugin, name, canManage, busy, onChange }: Readonly<{
  plugin: WorkspacePlugin
  name: string
  canManage: boolean
  busy: boolean
  onChange: (id: string, enabled: boolean) => void
}>) {
  const { t } = useTranslation()
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
      <p className="min-w-0 flex-1 text-sm font-medium text-text-strong break-words">{name}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx('badge', plugin.enabled ? 'badge-ok' : 'badge-muted')}>
          {plugin.enabled ? t('workspaces.settings.pluginOn') : t('workspaces.settings.pluginOff')}
        </span>
        {canManage ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            aria-label={plugin.enabled ? t('workspaces.settings.disableWho', { name }) : t('workspaces.settings.enableWho', { name })}
            onClick={() => onChange(plugin.id, !plugin.enabled)}>
            {plugin.enabled ? t('workspaces.settings.disable') : t('workspaces.settings.enable')}
          </button>
        ) : null}
      </div>
    </li>
  )
}
