/**
 * @fileoverview The workspace's plugins (`GET /me/workspaces/current/plugins`; docs/multi-workspace.md →
 * Per-workspace configuration): every plugin the deployment offers, in the server's order, and whether this
 * workspace turned it on. Every member reads the list; a workspace admin gets Enable or Disable on each.
 *
 * Enabling is held until phase 2's retention slice: the server answers 409 (`INGESTION_NOT_YET`) to everyone and
 * writes nothing. The list does not say so, so the card learns it from the first refusal: it then says why in a note
 * and makes every Enable inert for the rest of the page's life (aria-disabled, still focusable and described by the
 * note). Disabling answers as the server allows (with no
 * `PLUGIN#` row written yet, nothing is enabled to disable). Nothing here starts or stops collecting feedback: every
 * plugin still collects for the whole deployment, as the card says.
 *
 * @module pages/WorkspaceSettings/WorkspacePluginsCard
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Info, Plug } from 'lucide-react'
import clsx from 'clsx'
import Notice from '../../components/Notice/Notice'
import { serverReason } from '../../lib/errors'
import { getPluginManifests } from '../../plugins'
import { usePluginCopy } from '../../plugins/pluginCopy'
import { workspacePluginsApi, workspacePluginsKey } from '../../api/workspacePluginsApi'
import type { WorkspacePlugin } from '../../api/workspacePluginsApi'
import RefusalAlert from '../../workspace/RefusalAlert'
import { INGESTION_NOT_YET, PLUGIN_REFUSALS } from '../../workspace/workspaceRefusals'
import { SECTION_TITLE } from '../Settings/sectionTitle'

/** Whether a failed change is the server holding every enable back (and not another refusal). */
function isHeld(error: unknown): boolean {
  return serverReason(error) === INGESTION_NOT_YET
}

/** A plugin's name in the UI language: its manifest's copy, else its id (a plugin this build has no manifest for). */
function usePluginName(): (id: string) => string {
  const copyOf = usePluginCopy()
  const manifests = getPluginManifests()
  return (id) => {
    const manifest = manifests.find((candidate) => candidate.id === id)
    return manifest === undefined ? id : copyOf(manifest).name
  }
}

function usePluginChange(workspaceId: string) {
  const queryClient = useQueryClient()
  // `held` lives for the page's life only: a reload asks the server again (the list does not say it is held).
  const [held, setHeld] = useState(false)
  const change = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => workspacePluginsApi.setEnabled(id, enabled),
    onError: (error) => { if (isHeld(error)) setHeld(true) },
    onSettled: () => queryClient.invalidateQueries({ queryKey: workspacePluginsKey(workspaceId) }),
  })
  return { change, held }
}

export default function WorkspacePluginsCard({ workspaceId, isAdmin }: Readonly<{ workspaceId: string; isAdmin: boolean }>) {
  const { t } = useTranslation()
  const noteId = useId()
  const query = useQuery({ queryKey: workspacePluginsKey(workspaceId), queryFn: workspacePluginsApi.list })
  const { change, held } = usePluginChange(workspaceId)
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
      {held ? <Notice variant="banner" tone="warn" role="status" icon={Info} text={<span id={noteId}>{t('workspaces.errors.ingestionNotYet')}</span>} /> : null}
      {isHeld(change.error) ? null : <RefusalAlert error={change.error} refusals={PLUGIN_REFUSALS} />}
      <PluginList query={query} nameOf={nameOf} canManage={isAdmin} busy={change.isPending} held={held} heldNoteId={noteId}
        onChange={(id, enabled) => change.mutate({ id, enabled })} />
    </section>
  )
}

interface PluginListProps {
  readonly query: { data: WorkspacePlugin[] | undefined; isPending: boolean; isError: boolean; refetch: () => unknown }
  readonly nameOf: (id: string) => string
  readonly canManage: boolean
  readonly busy: boolean
  readonly held: boolean
  readonly heldNoteId: string
  readonly onChange: (id: string, enabled: boolean) => void
}

function PluginList({ query, nameOf, canManage, busy, held, heldNoteId, onChange }: PluginListProps) {
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
          held={held} heldNoteId={heldNoteId} onChange={onChange} />
      ))}
    </ul>
  )
}

function PluginRow({ plugin, name, canManage, busy, held, heldNoteId, onChange }: Readonly<{
  plugin: WorkspacePlugin
  name: string
  canManage: boolean
  busy: boolean
  held: boolean
  heldNoteId: string
  onChange: (id: string, enabled: boolean) => void
}>) {
  const { t } = useTranslation()
  // An enable the server holds back is offered no more once it said so; a disable always is.
  const enableHeld = !plugin.enabled && held
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
      <p className="min-w-0 flex-1 text-sm font-medium text-text-strong break-words">{name}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx('badge', plugin.enabled ? 'badge-ok' : 'badge-muted')}>
          {plugin.enabled ? t('workspaces.settings.pluginOn') : t('workspaces.settings.pluginOff')}
        </span>
        {canManage ? (
          // A held Enable stays focusable (aria-disabled, not disabled), so its description, the note, is read
          // when a keyboard user reaches it; pressing it then does nothing.
          <button type="button" className={clsx('btn btn-secondary btn-sm', enableHeld && 'opacity-60 cursor-not-allowed')}
            disabled={busy} aria-disabled={enableHeld || undefined}
            aria-describedby={enableHeld ? heldNoteId : undefined}
            aria-label={plugin.enabled ? t('workspaces.settings.disableWho', { name }) : t('workspaces.settings.enableWho', { name })}
            onClick={() => { if (!enableHeld) onChange(plugin.id, !plugin.enabled) }}>
            {plugin.enabled ? t('workspaces.settings.disable') : t('workspaces.settings.enable')}
          </button>
        ) : null}
      </div>
    </li>
  )
}
