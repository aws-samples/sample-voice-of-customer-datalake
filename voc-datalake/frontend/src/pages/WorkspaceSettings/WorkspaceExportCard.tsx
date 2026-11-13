/**
 * @fileoverview The workspace's export (docs/multi-workspace.md → Export and delete, step 2), for its admins:
 * Start an export (`POST /me/workspaces/current/export`), its status (`GET`, polled every few seconds while it is
 * queued or running, and no longer once it is done or failed), then Download: each press asks for a fresh,
 * audited 15-minute link (`POST …/export/link`) and opens it (an attachment: the browser saves the zip and the page
 * stays). A `cancelled` export reads as failed (api/workspaceExportApi.ts). A completed export can be downloaded for 7 days.
 * Every refusal (an export or an erasure already running, a link for an export no longer downloadable, an admin
 * demoted meanwhile) is said in words.
 *
 * @module pages/WorkspaceSettings/WorkspaceExportCard
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Download, PackageOpen } from 'lucide-react'
import clsx from 'clsx'
import Notice from '../../components/Notice/Notice'
import { isExportRunning, workspaceExportApi, workspaceExportKey } from '../../api/workspaceExportApi'
import type { WorkspaceExport } from '../../api/workspaceExportApi'
import { formatDateTime } from '../../utils/dateUtils'
import RefusalAlert from '../../workspace/RefusalAlert'
import { EXPORT_REFUSALS } from '../../workspace/workspaceRefusals'
import { SECTION_TITLE } from '../Settings/sectionTitle'

/** How often the status is read again while the export is being made. */
export const EXPORT_POLL_MS = 5000

const BADGE: Record<WorkspaceExport['status'], string> = {
  queued: 'badge-muted', running: 'badge-muted', completed: 'badge-ok', failed: 'badge-danger', expired: 'badge-muted',
  erased: 'badge-warn',
}

export default function WorkspaceExportCard({ workspaceId, isAdmin }: Readonly<{ workspaceId: string; isAdmin: boolean }>) {
  const { t } = useTranslation()
  return (
    <section className="card space-y-4" aria-labelledby="workspace-export-title">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <PackageOpen className="text-accent" size={16} aria-hidden="true" />
          <h2 id="workspace-export-title" className={SECTION_TITLE}>{t('workspaces.export.title')}</h2>
        </div>
        <p className="text-sm text-muted">{t('workspaces.export.description')}</p>
      </div>
      {isAdmin ? <ExportControls workspaceId={workspaceId} /> : <p className="text-sm text-muted">{t('workspaces.export.readOnly')}</p>}
    </section>
  )
}

function ExportControls({ workspaceId }: Readonly<{ workspaceId: string }>) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const key = workspaceExportKey(workspaceId)
  const query = useQuery({
    queryKey: key,
    queryFn: workspaceExportApi.status,
    // Polled only while the export is being made: a finished, failed or absent one is read once.
    refetchInterval: (current) => {
      const data = current.state.data
      return data !== undefined && data !== null && isExportRunning(data.status) ? EXPORT_POLL_MS : false
    },
  })
  const start = useMutation({
    mutationFn: workspaceExportApi.start,
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })
  const link = useMutation({
    mutationFn: workspaceExportApi.link,
    // The link is a download (the zip as an attachment), so the page itself goes to it and stays: a new window opened
    // after the request's await would be a popup the browser may block.
    onSuccess: ({ url }) => { window.location.assign(url) },
    // A refused link (the 7 days over meanwhile) changes the status shown: read it again.
    onError: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  if (query.isPending) return <p className="text-sm text-muted" role="status">{t('workspaces.export.loading')}</p>
  if (query.isError) {
    return (
      <Notice variant="banner" tone="danger" role="alert" icon={AlertCircle} text={t('workspaces.export.loadFailed')}
        action={{ label: t('workspaces.export.retry'), onClick: () => void query.refetch() }} />
    )
  }
  const current = query.data
  return (
    <div className="space-y-3">
      {current === null ? <p className="text-sm text-muted">{t('workspaces.export.none')}</p> : <ExportStatusLine current={current} />}
      <RefusalAlert error={start.error ?? link.error} refusals={EXPORT_REFUSALS} />
      <ExportActions current={current}
        start={{ busy: start.isPending, run: () => { link.reset(); start.mutate() } }}
        download={{ busy: link.isPending, run: () => { start.reset(); link.mutate() } }} />
    </div>
  )
}

interface Action {
  readonly busy: boolean
  readonly run: () => void
}

/** Download (a completed export only), and Start an export (not while one is being made). */
function ExportActions({ current, start, download }: Readonly<{ current: WorkspaceExport | null; start: Action; download: Action }>) {
  const { t } = useTranslation()
  const completed = current?.status === 'completed'
  const running = current !== null && isExportRunning(current.status)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {completed ? (
          <button type="button" className="btn btn-primary btn-sm gap-1.5" disabled={download.busy} onClick={download.run}>
            <Download size={14} aria-hidden="true" />
            {download.busy ? t('workspaces.export.downloading') : t('workspaces.export.download')}
          </button>
        ) : null}
        <button type="button" className={clsx('btn btn-sm', completed ? 'btn-secondary' : 'btn-primary')}
          disabled={running || start.busy} onClick={start.run}>
          {start.busy ? t('workspaces.export.starting') : t('workspaces.export.start')}
        </button>
      </div>
      {completed ? <p className="text-xs text-muted">{t('workspaces.export.linkNote')}</p> : null}
    </>
  )
}

function ExportStatusLine({ current }: Readonly<{ current: WorkspaceExport }>) {
  const { t, i18n } = useTranslation()
  const when = (value: string | undefined) => formatDateTime(value ?? '', i18n.language)
  const note = {
    queued: t('workspaces.export.runningNote'),
    running: t('workspaces.export.runningNote'),
    completed: t('workspaces.export.completedNote', { date: when(current.completed_at), until: when(current.expires_at) }),
    failed: t('workspaces.export.failedNote'),
    expired: t('workspaces.export.expiredNote'),
    erased: t('workspaces.export.erasedNote'),
  }[current.status]
  const label = {
    queued: t('workspaces.export.status.queued'),
    running: t('workspaces.export.status.running'),
    completed: t('workspaces.export.status.completed'),
    failed: t('workspaces.export.status.failed'),
    expired: t('workspaces.export.status.expired'),
    erased: t('workspaces.export.status.erased'),
  }[current.status]
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center" role="status" aria-live="polite">
      <span className={clsx('badge self-start', BADGE[current.status])}>{label}</span>
      <p className="text-sm text-text-strong min-w-0 break-words">{note}</p>
    </div>
  )
}
