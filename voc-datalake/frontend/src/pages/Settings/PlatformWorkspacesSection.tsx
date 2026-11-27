/**
 * @fileoverview The platform console: Administration → Workspaces → All workspaces, for platform admins only
 * (docs/multi-workspace.md → Control plane; the section is hidden from everyone else, and the API answers them 403).
 *
 * - Every workspace of the deployment by name, a page at a time: name, slug and status (no credentials badge since
 *   decision 19: a workspace's credentials need no secret, docs/multi-workspace.md → Credentials).
 * - Create one (name and slug, CreateWorkspaceForm.tsx, the form the workspace gate's picker offers too): the caller
 *   becomes its admin. A slug another workspace has is refused (409).
 * - Enter one: a full page load to `/workspace/{slug}/`. A platform admin who is not a member enters as admin, which the
 *   server checks live and audits; the console records the workspace for the gate first (`enterWorkspace.ts`),
 *   because the caller's own list does not name it.
 * - Create a trial (7.71.00, trial/CreateTrialDialog.tsx): a workspace with an end, its people and a starter pack, then
 *   its import wizard. A trial's row says its state and offers Extend and Convert (trial/TrialActions.tsx); at its end
 *   it only pauses, it never deletes itself.
 *
 * @module pages/Settings/PlatformWorkspacesSection
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Building2, Hourglass, Info, LogIn } from 'lucide-react'
import CursorPagesList from '../../components/CursorPagesList/CursorPagesList'
import Notice from '../../components/Notice/Notice'
import { useExpiringValue } from '../../hooks/useExpiringValue'
import type { CursorPagesQuery } from '../../hooks/useCursorPages'
import { apiErrorStatus, HTTP_FORBIDDEN } from '../../api/apiErrorStatus'
import { useCursorPages } from '../../hooks/useCursorPages'
import { platformWorkspacesApi, platformWorkspacesKey } from '../../api/platformWorkspacesApi'
import type { PlatformWorkspace } from '../../api/platformWorkspacesApi'
import RefusalAlert from '../../workspace/RefusalAlert'
import { enterWorkspace } from '../../workspace/enterWorkspace'
import type { PlatformEntry } from '../../workspace/platformEntry'
import { workspaceUrl } from '../../workspace/workspacePath'
import { PLATFORM_REFUSALS } from '../../workspace/workspaceRefusals'
import CreateWorkspaceForm from './CreateWorkspaceForm'
import { SECTION_TITLE } from './sectionTitle'
import CreateTrialDialog from './trial/CreateTrialDialog'
import TrialActions, { TrialBadge } from './trial/TrialActions'

/** Where a new trial opens: its import wizard (7.67.00), for its feedback and the workshop's survey. */
const IMPORT_WIZARD_PATH = '/scrapers/import'

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

function WorkspaceRow({ workspace }: Readonly<{ workspace: PlatformWorkspace }>) {
  const { t } = useTranslation()
  const status = workspace.status === 'active' || workspace.status === 'deleting'
    ? t(`workspaces.platform.status.${workspace.status}`)
    : workspace.status
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-strong break-words">{workspace.name}</p>
        <p className="text-xs text-muted font-mono break-all">{workspaceUrl(workspace.slug, '/')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {status === '' ? null : <span className="badge badge-muted">{status}</span>}
        {workspace.trial === null ? null : <TrialBadge trial={workspace.trial} />}
        <EnterButton workspace={workspace} label={t('workspaces.platform.enter')} className="btn btn-secondary btn-sm gap-1.5" />
      </div>
      <TrialActions workspace={workspace} />
    </li>
  )
}

export default function PlatformWorkspacesSection() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { query, rows: workspaces } = useCursorPages<PlatformWorkspace>(platformWorkspacesKey(), platformWorkspacesApi.list)
  const [created, showCreated] = useExpiringValue<{ name: string; slug: string; id: string }>(15000)
  const [creatingTrial, setCreatingTrial] = useState(false)

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

      <CreateWorkspaceForm onCreated={showCreated} />
      <div className="flex flex-col gap-2 rounded-lg border border-border p-4 sm:flex-row sm:items-center">
        <p className="flex-1 text-sm text-muted">{t('workspaces.trial.createDescription')}</p>
        <button type="button" className="btn btn-secondary gap-2 self-start sm:self-auto" onClick={() => setCreatingTrial(true)}>
          <Hourglass size={16} aria-hidden="true" />{t('workspaces.trial.create')}
        </button>
      </div>
      {creatingTrial ? (
        <CreateTrialDialog
          onClose={() => {
            setCreatingTrial(false)
            void queryClient.invalidateQueries({ queryKey: platformWorkspacesKey() })
          }}
          onOpenImport={(workspace) => enterWorkspace(workspace, IMPORT_WIZARD_PATH)} />
      ) : null}
      {created === null ? null : (
        <div role="status" className="flex flex-col gap-2 rounded-lg bg-ok-subtle p-3 text-sm text-ok sm:flex-row sm:items-center">
          <span className="flex-1">{t('workspaces.platform.created', { name: created.name })}</span>
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
