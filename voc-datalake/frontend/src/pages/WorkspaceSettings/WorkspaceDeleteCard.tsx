/**
 * @fileoverview The workspace's delete (docs/multi-workspace.md → Export and delete, steps 3 and 4), for its admins on
 * a deployment that turns it on (config.json `features.workspaceDelete`; the page decides whether to show it). The card
 * says that the delete is permanent and cannot be undone and what it removes, and points to the export above; Delete
 * workspace opens the confirmation (DeleteWorkspaceDialog.tsx), which sends `POST /me/workspaces/current/delete`.
 *
 * On its 202 the workspace is gone for every member at once and its data is deleted in the background once the job's
 * fence (about 20 minutes) has passed: a last dialog says so, and its one button leaves with a full page load to `/`,
 * as leaving a workspace does (Members), which also empties every cache. Before it goes, this tab remembers the
 * workspace as refused (refusedWorkspaces.ts: `GET /me/workspaces` still lists it until the job removes its rows, and
 * the gate must not offer it or move back into it) and this browser forgets the workspace's own saved records.
 *
 * @module pages/WorkspaceSettings/WorkspaceDeleteCard
 */
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import { workspaceDeleteApi } from '../../api/workspaceDeleteApi'
import type { WorkspaceDelete } from '../../api/workspaceDeleteApi'
import { formatTime } from '../../utils/dateUtils'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import { rememberRefused } from '../../workspace/refusedWorkspaces'
import { forgetWorkspaceRecords } from '../../workspace/workspaceStorage'
import { SECTION_TITLE } from '../Settings/sectionTitle'
import DeleteWorkspaceDialog from './DeleteWorkspaceDialog'
import { EXPORT_CARD_ID } from './WorkspaceExportCard'
import { DeletedContents, ExportFirst } from './workspaceDeleteParts'

/** Move to the export card (focus scrolls it into view). */
function focusExportCard(): void {
  document.getElementById(EXPORT_CARD_ID)?.focus()
}

/** Leave the deleted workspace: a full page load to `/`, where the gate offers the workspaces left. */
function leaveDeletedWorkspace(workspace: CurrentWorkspace): void {
  rememberRefused(workspace.id)
  forgetWorkspaceRecords(workspace.slug)
  window.location.assign('/')
}

export default function WorkspaceDeleteCard({ workspace }: Readonly<{ workspace: CurrentWorkspace }>) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const request = useMutation({
    mutationFn: ({ confirmSlug, reason }: { confirmSlug: string; reason: string }) => workspaceDeleteApi.request(confirmSlug, reason),
    // Its records go at once too: a tab closed now, not through the last dialog, leaves none behind.
    onSuccess: () => forgetWorkspaceRecords(workspace.slug),
  })
  const showExport = () => {
    setConfirming(false)
    // After the dialog has closed and handed focus back to its trigger.
    window.setTimeout(focusExportCard, 0)
  }
  return (
    <section className="card space-y-4 border-danger/40" aria-labelledby="workspace-delete-title">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Trash2 className="text-danger" size={16} aria-hidden="true" />
          <h2 id="workspace-delete-title" className={SECTION_TITLE}>{t('workspaces.delete.title')}</h2>
        </div>
        <p className="text-sm font-semibold text-danger">{t('workspaces.delete.permanent')}</p>
      </div>
      <DeletedContents />
      <ExportFirst onShowExport={showExport} />
      <button type="button" className="btn btn-danger gap-2 justify-center"
        onClick={() => { request.reset(); setConfirming(true) }}>
        <Trash2 size={16} aria-hidden="true" />
        {t('workspaces.delete.open')}
      </button>
      {confirming && request.data === undefined ? (
        <DeleteWorkspaceDialog workspace={workspace} pending={request.isPending} error={request.error}
          onConfirm={(confirmSlug, reason) => request.mutate({ confirmSlug, reason })}
          onCancel={() => setConfirming(false)} onShowExport={showExport} />
      ) : null}
      {request.data === undefined ? null : (
        <WorkspaceDeletedDialog name={workspace.name} deleted={request.data} onLeave={() => leaveDeletedWorkspace(workspace)} />
      )}
    </section>
  )
}

/** The last word: the workspace is gone for everyone, its data goes in the background; the one way on is to leave. */
function WorkspaceDeletedDialog({ name, deleted, onLeave }: Readonly<{ name: string; deleted: WorkspaceDelete; onLeave: () => void }>) {
  const { t, i18n } = useTranslation()
  const titleId = useId()
  const time = deleted.fenceAt === null ? '' : formatTime(deleted.fenceAt, i18n.language)
  return (
    <ModalShell isOpen onClose={onLeave} ariaLabelledBy={titleId} dismissable={false} panelClassName="w-full max-w-md">
      <div className="dialog-header">
        <Trash2 size={18} className="text-danger shrink-0" aria-hidden="true" />
        <h2 id={titleId} className="dialog-title">{t('workspaces.delete.doneTitle', { name })}</h2>
      </div>
      <div className="dialog-body space-y-2" role="status">
        <p className="text-sm text-text">{t('workspaces.delete.doneGone')}</p>
        <p className="text-sm text-muted">
          {time === '' ? t('workspaces.delete.doneBackground') : t('workspaces.delete.doneBackgroundAt', { time })}
        </p>
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn btn-primary" onClick={onLeave}>{t('workspaces.delete.leave')}</button>
      </div>
    </ModalShell>
  )
}
