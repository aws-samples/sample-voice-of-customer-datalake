/**
 * @fileoverview The workspace's name (docs/multi-workspace.md → Control plane), on its settings page: every member
 * reads it and its address; its admins rename it (`PUT /me/workspaces/current` `{name}`, with the workspace's
 * `X-Workspace-Id`). The name is checked here by the server's rules first (workspaceName.ts); the slug, so the address
 * `/w/{slug}`, never changes.
 *
 * A rename's answer is the workspace as `GET /me/workspaces/current` answers it: it is written straight into that
 * cache entry and the caller's list (`GET /me/workspaces`), so the header's workspace menu, the gate and this card show
 * the new name at once. Neither is read again then: another warm API container may answer the old name for up to its
 * membership cache's 30 s. A refused rename reads both again (a change made meanwhile), and each refusal is said in
 * words (`RENAME_REFUSALS`).
 *
 * @module pages/WorkspaceSettings/WorkspaceNameCard
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Building2, Pencil } from 'lucide-react'
import { NameDialog } from '../../components/NameDialog/NameDialog'
import { useExpiringValue } from '../../hooks/useExpiringValue'
import { WORKSPACE_NAME_MAX, platformWorkspacesKey } from '../../api/platformWorkspacesApi'
import { currentWorkspaceKey, myWorkspacesKey, workspacesApi } from '../../api/workspacesApi'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import { useServerWorkspace } from '../../workspace/useMyWorkspaces'
import { RENAME_REFUSALS, workspaceRefusalMessage } from '../../workspace/workspaceRefusals'
import { SECTION_TITLE } from '../Settings/sectionTitle'
import { workspaceNameProblem } from './workspaceName'
import type { WorkspaceNameProblem } from './workspaceName'

/** How long the "renamed" line stays. */
const DONE_MS = 6000

function useRenameWorkspace(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => workspacesApi.rename(name),
    onSuccess: (renamed) => {
      queryClient.setQueryData(currentWorkspaceKey(workspaceId), renamed)
      queryClient.setQueryData<CurrentWorkspace[]>(myWorkspacesKey(), (old) =>
        old?.map((row) => (row.id === renamed.id ? { ...row, name: renamed.name } : row)))
      // The platform console's list (Administration) names it too: read again when it is next shown.
      void queryClient.invalidateQueries({ queryKey: platformWorkspacesKey() })
    },
    // Renamed or removed meanwhile, or the caller demoted: what the page shows is read again.
    onError: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: myWorkspacesKey(), exact: true }),
      queryClient.invalidateQueries({ queryKey: currentWorkspaceKey(workspaceId) }),
    ]),
  })
}

export default function WorkspaceNameCard({ workspace, isAdmin }: Readonly<{ workspace: CurrentWorkspace; isAdmin: boolean }>) {
  const { t } = useTranslation()
  const server = useServerWorkspace(workspace.id)
  // The server's answer once it has one (a rename writes it there first); the gate's record until then.
  const name = server.data?.id === workspace.id ? server.data.name : workspace.name
  const address = `/w/${workspace.slug}`
  const rename = useRenameWorkspace(workspace.id)
  const [editing, setEditing] = useState(false)
  const [problem, setProblem] = useState<WorkspaceNameProblem | null>(null)
  const [done, showDone, clearDone] = useExpiringValue<string>(DONE_MS)

  const open = () => {
    rename.reset()
    setProblem(null)
    clearDone()
    setEditing(true)
  }
  const save = (typed: string) => {
    const found = workspaceNameProblem(typed)
    setProblem(found)
    if (found !== null) return
    rename.mutate(typed.trim(), {
      onSuccess: (renamed) => {
        setEditing(false)
        showDone(t('workspaces.rename.done', { name: renamed.name }))
      },
    })
  }

  return (
    <section className="card space-y-3" aria-labelledby="workspace-name-title">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Building2 className="text-accent" size={16} aria-hidden="true" />
          <h2 id="workspace-name-title" className={SECTION_TITLE}>{t('workspaces.rename.title')}</h2>
        </div>
        <p className="text-sm text-muted">{t('workspaces.rename.description')}</p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-medium text-text-strong break-words [overflow-wrap:anywhere]">{name}</p>
          <p className="text-xs text-muted break-words">
            {t('workspaces.rename.address')} <span className="font-mono">{address}</span>
          </p>
        </div>
        {isAdmin ? (
          <button type="button" className="btn btn-secondary btn-sm gap-1.5 self-start sm:self-auto" onClick={open}>
            <Pencil size={14} aria-hidden="true" />
            {t('workspaces.rename.open')}
          </button>
        ) : null}
      </div>
      {isAdmin ? null : <p className="text-sm text-muted">{t('workspaces.rename.readOnly')}</p>}
      {done === null ? null : <p role="status" className="rounded-lg bg-ok-subtle p-3 text-sm text-ok">{done}</p>}
      {editing ? (
        <NameDialog title={t('workspaces.rename.dialogTitle')} hint={t('workspaces.rename.slugStays', { address })}
          label={t('workspaces.rename.label')} maxLength={WORKSPACE_NAME_MAX} submitLabel={t('workspaces.rename.save')}
          initialName={name} saving={rename.isPending} error={renameErrorText(problem, rename.error, t)}
          onSave={save} onClose={() => { if (!rename.isPending) setEditing(false) }} />
      ) : null}
    </section>
  )
}

/** The dialog's error line: the name's own problem first, then the server's refusal in words; none without either. */
function renameErrorText(problem: WorkspaceNameProblem | null, error: Error | null, t: TFunction): string | undefined {
  if (problem === 'length') return t('workspaces.rename.nameInvalid', { max: WORKSPACE_NAME_MAX })
  if (problem === 'control') return t('workspaces.rename.nameControl')
  if (error === null) return undefined
  const { messageKey, reason } = workspaceRefusalMessage(error, RENAME_REFUSALS)
  return t(messageKey, { reason })
}
