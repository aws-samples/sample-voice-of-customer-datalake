/**
 * @fileoverview The platform console: Administration → Privacy & access → Workspaces, for platform admins only
 * (docs/multi-workspace.md → Control plane; the section is hidden from everyone else, and the API answers them 403).
 *
 * - Every workspace of the deployment by name, a page at a time: name, slug, status and whether its credentials
 *   secret exists (`pending` until it does).
 * - Create one (name and slug): the caller becomes its admin. A slug another workspace has is refused (409).
 * - Enter one: a full page load to `/w/{slug}/`. A platform admin who is not a member enters as admin, which the
 *   server checks live and audits; the console records the workspace for the gate first (`platformEntry.ts`),
 *   because the caller's own list does not name it.
 *
 * @module pages/Settings/PlatformWorkspacesSection
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { Building2, Info, LogIn } from 'lucide-react'
import CursorPagesList from '../../components/CursorPagesList/CursorPagesList'
import Notice from '../../components/Notice/Notice'
import { useExpiringValue } from '../../hooks/useExpiringValue'
import type { CursorPagesQuery } from '../../hooks/useCursorPages'
import { apiErrorStatus, HTTP_FORBIDDEN } from '../../api/apiErrorStatus'
import { useCursorPages } from '../../hooks/useCursorPages'
import { myWorkspacesKey } from '../../api/workspacesApi'
import { platformWorkspacesApi, platformWorkspacesKey } from '../../api/platformWorkspacesApi'
import type { PlatformWorkspace, SecretStatus } from '../../api/platformWorkspacesApi'
import RefusalAlert from '../../workspace/RefusalAlert'
import { rememberPlatformEntry } from '../../workspace/platformEntry'
import type { PlatformEntry } from '../../workspace/platformEntry'
import { workspaceUrl } from '../../workspace/workspacePath'
import { PLATFORM_REFUSALS } from '../../workspace/workspaceRefusals'
import CreateWorkspaceForm from './CreateWorkspaceForm'
import { SECTION_TITLE } from './sectionTitle'

/** Enter `workspace` with a full page load, the gate told which workspace the address names. */
function enterWorkspace(workspace: PlatformEntry): void {
  rememberPlatformEntry(workspace)
  window.location.assign(workspaceUrl(workspace.slug, '/'))
}

/**
 * Enter. Its slug is always one that can be a base path: the API client's schema (`isWorkspaceSlug`,
 * platformWorkspacesApi.ts) leaves out any row, or any create answer, whose slug could not be one.
 */
function EnterButton({ workspace, label, className }: Readonly<{ workspace: PlatformEntry & { name: string }; label: string; className: string }>) {
  const { t } = useTranslation()
  return (
    <button type="button" className={className} onClick={() => enterWorkspace(workspace)}
      aria-label={t('workspaces.platform.enterWho', { name: workspace.name })}>
      <LogIn size={14} aria-hidden="true" />
      {label}
    </button>
  )
}

/** Whether the workspace's credentials secret exists; a pending one says why in its title. */
function SecretBadge({ status }: Readonly<{ status: SecretStatus }>) {
  const { t } = useTranslation()
  const ready = status === 'ready'
  const label = ready ? t('workspaces.platform.secretReady') : t('workspaces.platform.secretPending')
  return <span className={clsx('badge', ready ? 'badge-ok' : 'badge-warn')} title={ready ? undefined : t('workspaces.platform.secretPendingHint')}>{label}</span>
}

function WorkspaceRow({ workspace }: Readonly<{ workspace: PlatformWorkspace }>) {
  const { t } = useTranslation()
  const status = workspace.status === 'active' || workspace.status === 'deleting'
    ? t(`workspaces.platform.status.${workspace.status}`)
    : workspace.status
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-strong break-words">{workspace.name}</p>
        <p className="text-xs text-muted font-mono break-all">/w/{workspace.slug}/</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status === '' ? null : <span className="badge badge-muted">{status}</span>}
        <SecretBadge status={workspace.secret_status} />
        <EnterButton workspace={workspace} label={t('workspaces.platform.enter')} className="btn btn-secondary btn-sm gap-1.5" />
      </div>
    </li>
  )
}

function hadWorkspaces(mine: unknown): boolean {
  return Array.isArray(mine) && mine.length > 0
}

export default function PlatformWorkspacesSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { query, rows: workspaces } = useCursorPages<PlatformWorkspace>(platformWorkspacesKey(), platformWorkspacesApi.list)
  const [created, showCreated] = useExpiringValue<{ name: string; slug: string; id: string; pending: boolean }>(15000)
  const create = useMutation({
    mutationFn: ({ name, slug }: { name: string; slug: string }) => platformWorkspacesApi.create(name, slug),
    // The new workspace is in the console's list and in the caller's own (they are its admin). The caller's own
    // list is re-read only when it already held a workspace: from none, a list of one would make the gate redirect
    // into it with a full page load, losing this result and its Enter button (Enter's own load reads it afresh).
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: platformWorkspacesKey() }),
      hadWorkspaces(queryClient.getQueryData(myWorkspacesKey()))
        ? queryClient.invalidateQueries({ queryKey: myWorkspacesKey() })
        : null,
    ]),
  })

  return (
    <div className="card space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Building2 className="text-accent" size={16} aria-hidden="true" />
          <h2 className={SECTION_TITLE}>{t('workspaces.platform.title')}</h2>
        </div>
        <p className="text-sm text-muted">{t('workspaces.platform.description')}</p>
      </div>
      <Notice variant="banner" tone="warn" role="note" icon={Info} text={t('workspaces.sharedData')} />

      <CreateWorkspaceForm
        busy={create.isPending}
        onCreate={(name, slug) => create.mutateAsync({ name, slug })}
        onCreated={(workspace) => showCreated({ ...workspace, pending: workspace.secret_status === 'pending' })}
      />
      <RefusalAlert error={create.error} refusals={PLATFORM_REFUSALS} />
      {created === null ? null : (
        <div role="status" className="flex flex-col gap-2 rounded-lg bg-ok-subtle p-3 text-sm text-ok sm:flex-row sm:items-center">
          <span className="flex-1">
            {created.pending
              ? t('workspaces.platform.createdPending', { name: created.name })
              : t('workspaces.platform.created', { name: created.name })}
          </span>
          <EnterButton workspace={created} label={t('workspaces.platform.enterWho', { name: created.name })}
            className="btn btn-secondary btn-sm gap-1.5 self-start" />
        </div>
      )}

      <WorkspaceList query={query} workspaces={workspaces} />
    </div>
  )
}

function WorkspaceList({ query, workspaces }: Readonly<{ query: CursorPagesQuery; workspaces: readonly PlatformWorkspace[] }>) {
  const { t } = useTranslation()
  const copy = {
    loading: t('workspaces.platform.loading'), loadFailed: t('workspaces.platform.loadFailed'),
    more: t('workspaces.platform.more'), moreFailed: t('workspaces.moreFailed'), refreshFailed: t('workspaces.refreshFailed'), empty: t('workspaces.platform.none'),
  }
  // A 403 (no longer a platform admin), on the first page or a later one, is said as such; any other failure
  // offers Try again (or Show more again).
  const refused = apiErrorStatus(query.error) === HTTP_FORBIDDEN
  return (
    <section aria-label={t('workspaces.platform.listLabel')}>
      <CursorPagesList query={query} count={workspaces.length} copy={copy}
        failure={refused ? <RefusalAlert error={query.error} refusals={PLATFORM_REFUSALS} /> : null}>
        <ul className="divide-y divide-border">
          {workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)}
        </ul>
      </CursorPagesList>
    </section>
  )
}
