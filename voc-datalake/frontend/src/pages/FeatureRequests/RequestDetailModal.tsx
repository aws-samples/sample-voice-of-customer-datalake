/**
 * @fileoverview One request in a dialog (deep-linked as `?request=<id>`): its description, its
 * template field values and totals, every support row, "+1" (or "Edit my +1" for someone who already
 * supports it), the reporter's/admin's edit, a share
 * link, and the admin controls.
 *
 * @module pages/FeatureRequests/RequestDetailModal
 */
import { Check, Link2, Pencil, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import ModalShell from '../../components/ModalShell/ModalShell'
import AddSupportForm from './AddSupportForm'
import AdminControls from './AdminControls'
import StatusBadge from './StatusBadge'
import SupportRow from './SupportRow'
import WriteError from './WriteError'
import RequestFieldValues from './RequestFieldValues'
import { RequestTotals } from './RequestTotals'
import DescriptionField from './DescriptionField'
import { descriptionError } from './templateDraft'
import { TextField } from './FormFields'
import { REQUEST_LIMITS, displayName } from './boardFormat'
import { shareLinkFor, useBoardHost, useCurrentBoard } from './boardContext'
import { useBoardWrite, useRequestDetail } from './useBoardQueries'
import type { BoardViewer, FeatureRequest, FeatureSupport } from '../../api/featureRequestsApi'

function CopyLinkButton({ requestId }: Readonly<{ requestId: string }>) {
  const { t } = useTranslation('featureRequests')
  const host = useBoardHost()
  const board = useCurrentBoard()
  const { copy, copiedKey } = useCopyToClipboard()
  const copied = copiedKey !== null
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(shareLinkFor(host, board.slug, requestId))}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />}
      {copied ? t('detail.copied') : t('detail.copyLink')}
    </button>
  )
}

function EditRequest({ request, onDone }: Readonly<{ request: FeatureRequest; onDone: () => void }>) {
  const { t } = useTranslation('featureRequests')
  const [title, setTitle] = useState(request.title)
  const [description, setDescription] = useState(request.description)
  const save = useBoardWrite(
    (api, input: { title: string; description: string }) => api.updateRequest(request.request_id, input),
    onDone,
  )
  const template = useCurrentBoard().template
  const ready = title.trim() !== '' && descriptionError(description, template) === undefined
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault()
      if (ready) save.mutate({ title: title.trim(), description: description.trim() })
    }}>
      <TextField label={t('form.title')} value={title} maxLength={REQUEST_LIMITS.title} onChange={setTitle} />
      <DescriptionField template={template} rows={5} value={description} onChange={setDescription} />
      <WriteError error={save.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>{t('actions.cancel')}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || save.isPending}>{t('actions.save')}</button>
      </div>
    </form>
  )
}

/** The viewer's own support of a request (one per person; emails compare case-insensitively), if any. */
function ownSupport(supports: readonly FeatureSupport[], viewer: BoardViewer): FeatureSupport | undefined {
  const email = viewer.email.toLowerCase()
  return email === '' ? undefined : supports.find((support) => support.email.toLowerCase() === email)
}

/**
 * Every support row, then "+1" — or, for someone who already supports the request (the reporter's
 * own +1 is filed with it), "Edit my +1" on their row: the API refuses a second one (409).
 */
function SupportsSection({ requestId, supports, viewer, initialName }: Readonly<{
  requestId: string; supports: readonly FeatureSupport[]; viewer: BoardViewer; initialName: string
}>) {
  const { t } = useTranslation('featureRequests')
  const [editingId, setEditingId] = useState<string | null>(null)
  const mine = ownSupport(supports, viewer)
  return (
    <section className="space-y-2" aria-label={t('detail.supports')}>
      <h3 className="text-sm font-medium text-text">{t('detail.supportsCount', { count: supports.length })}</h3>
      <ul className="space-y-2">
        {supports.map((support) => (
          <SupportRow key={support.support_id} requestId={requestId} support={support} viewer={viewer}
            editing={editingId === support.support_id}
            onEditingChange={(editing) => setEditingId(editing ? support.support_id : null)} />
        ))}
      </ul>
      {mine === undefined ? <AddSupportForm requestId={requestId} initialName={initialName} /> : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted">{t('detail.alreadySupporting')}</p>
          {editingId === mine.support_id ? null : (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingId(mine.support_id)}>
              <Pencil size={14} aria-hidden="true" />{t('detail.editMySupport')}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function DetailBody({ requestId, viewer, initialName, onClose }: Readonly<{
  requestId: string; viewer: BoardViewer; initialName: string; onClose: () => void
}>) {
  const { t } = useTranslation('featureRequests')
  const detail = useRequestDetail(requestId)
  const [editing, setEditing] = useState(false)
  if (detail.isLoading) return <p className="dialog-body text-sm text-muted">{t('loading')}</p>
  if (!detail.data) {
    return (
      <div className="dialog-body">
        <LoadFailed message={t('detail.loadFailed')} onRetry={() => { void detail.refetch() }} retrying={detail.isFetching} />
      </div>
    )
  }
  const { request, supports } = detail.data
  const canEdit = viewer.is_admin || (viewer.email !== '' && request.reporter_email === viewer.email)
  return (
    <div className="dialog-body space-y-4">
      {editing ? <EditRequest request={request} onDone={() => setEditing(false)} /> : (
        <div className="space-y-2">
          <p className="text-sm text-text whitespace-pre-wrap break-words">{request.description}</p>
          <p className="text-xs text-muted break-words">
            {t('detail.reported', { name: displayName(request.reporter_name, request.reporter_email), email: request.reporter_email })}
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <CopyLinkButton requestId={request.request_id} />
        {canEdit && !editing ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            <Pencil size={14} aria-hidden="true" />{t('detail.edit')}
          </button>
        ) : null}
      </div>
      <RequestFieldValues request={request} />
      <RequestTotals request={request} />
      <SupportsSection requestId={request.request_id} supports={supports} viewer={viewer} initialName={initialName} />
      {viewer.is_admin ? <AdminControls request={request} onDeleted={onClose} /> : null}
    </div>
  )
}

export default function RequestDetailModal({ requestId, title, viewer, initialName, onClose }: Readonly<{
  requestId: string
  /** The title from the list, shown while the detail loads. */
  title: string
  viewer: BoardViewer
  initialName: string
  onClose: () => void
}>) {
  const { t } = useTranslation('featureRequests')
  const headingId = useId()
  const detail = useRequestDetail(requestId)
  const request = detail.data?.request
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={headingId} panelClassName="w-full max-w-3xl">
      <div className="dialog-header">
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="dialog-title break-words">{request?.title ?? title}</h2>
          {request ? <StatusBadge status={request.status} /> : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t('actions.close')}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <DetailBody requestId={requestId} viewer={viewer} initialName={initialName} onClose={onClose} />
    </ModalShell>
  )
}
