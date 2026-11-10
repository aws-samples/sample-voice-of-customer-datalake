/**
 * @fileoverview One support row of a request: who, which customer and deal, the revenue impact,
 * and — for its author or an admin — edit and delete.
 *
 * @module pages/FeatureRequests/SupportRow
 */
import { Mail, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { isEnabled } from '../../api/boardFields'
import { displayName, draftOfSupport, formatUsd, supportSpecOf, supportValuesOf } from './boardFormat'
import { useCurrentBoard } from './boardContext'
import SupportFields from './SupportFields'
import WriteError from './WriteError'
import { useBoardWrite } from './useBoardQueries'
import { useSupportDraft } from './useSupportDraft'
import type { BoardViewer, FeatureSupport, SupportInput } from '../../api/featureRequestsApi'
import { IMPACT_LABELS } from './boardLabels'

const IMPACT_TINT = { committed: 'badge-ok', at_risk: 'badge-danger', none: 'badge-muted' } as const

function EditSupport({ requestId, support, onDone }: Readonly<{ requestId: string; support: FeatureSupport; onDone: () => void }>) {
  const { t } = useTranslation('featureRequests')
  const spec = supportSpecOf(useCurrentBoard().fields, 'support')
  const form = useSupportDraft(draftOfSupport(support), spec)
  const save = useBoardWrite(
    (api, input: SupportInput) => api.updateSupport(requestId, support.support_id, input),
    onDone,
  )
  return (
    <form className="space-y-3" noValidate onSubmit={(e) => {
      e.preventDefault()
      if (form.attempt()) save.mutate({ name: form.draft.name.trim(), fields: supportValuesOf(form.draft, spec) })
    }}>
      <SupportFields draft={form.draft} errors={form.errors} spec={spec} onChange={form.setDraft} />
      <WriteError error={save.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>{t('actions.cancel')}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>{t('actions.save')}</button>
      </div>
    </form>
  )
}

function ImpactFacts({ support }: Readonly<{ support: FeatureSupport }>) {
  const { t, i18n } = useTranslation('featureRequests')
  const showsImpact = isEnabled(useCurrentBoard().fields.support, 'impact')
  if (!showsImpact && support.contact_email === undefined) return null
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs">
      {showsImpact ? <span className={`badge ${IMPACT_TINT[support.impact]}`}>{t(IMPACT_LABELS[support.impact].labelKey)}</span> : null}
      {showsImpact && support.impact !== 'none' ? <span className="font-medium text-text">{formatUsd(support.amount_usd, i18n.language)}</span> : null}
      {support.contact_email === undefined ? null : (
        <a className="link inline-flex items-center gap-1 break-all" href={`mailto:${support.contact_email}`}>
          <Mail size={12} aria-hidden="true" />{t('detail.contact', { email: support.contact_email })}
        </a>
      )}
    </p>
  )
}

/** What a support row is named by in its buttons: its customer, else its author. */
function supportSubject(support: FeatureSupport): string {
  return support.customer === '' ? displayName(support.name, support.email) : support.customer
}

function SupportFacts({ support }: Readonly<{ support: FeatureSupport }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm text-text break-words">
        <span className="font-medium">{displayName(support.name, support.email)}</span>
        {' · '}
        <a className="link" href={`mailto:${support.email}`}>{support.email}</a>
        {/* A real space, not only a margin: copied text and screen readers read "a@b.comReporter" otherwise (5.34.00). */}
        {support.is_reporter ? <>{' '}<span className="badge badge-info ml-1">{t('detail.reporter')}</span></> : null}
      </p>
      {support.customer === '' && support.deal === undefined ? null : (
        <p className="text-sm text-text break-words">
          {support.customer}
          {support.deal === undefined ? null : <span className="text-muted">{support.customer === '' ? '' : ' · '}{support.deal}</span>}
        </p>
      )}
      <ImpactFacts support={support} />
      {support.note === undefined ? null : <p className="text-xs text-muted whitespace-pre-wrap break-words">{support.note}</p>}
    </div>
  )
}

export default function SupportRow({ requestId, support, viewer, editing, onEditingChange }: Readonly<{
  requestId: string
  support: FeatureSupport
  viewer: BoardViewer
  /** Held by the request dialog, so its "Edit my +1" can open the viewer's own row. */
  editing: boolean
  onEditingChange: (editing: boolean) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const setEditing = onEditingChange
  const [confirming, setConfirming] = useState(false)
  const remove = useBoardWrite((api, supportId: string) => api.deleteSupport(requestId, supportId), () => setConfirming(false))
  const isOwner = viewer.email !== '' && support.email === viewer.email
  // A paused board takes no edit from anyone; an admin may still remove a +1 (triage), its author may not.
  const paused = useCurrentBoard().paused
  const canEditRow = !paused && (viewer.is_admin || isOwner)
  const canRemove = viewer.is_admin || (!paused && isOwner)
  if (editing) {
    return <li className="card p-3"><EditSupport requestId={requestId} support={support} onDone={() => setEditing(false)} /></li>
  }
  return (
    <li className="card p-3 flex flex-wrap items-start justify-between gap-2">
      <SupportFacts support={support} />
      {canEditRow || canRemove ? (
        <div className="flex gap-1">
          {canEditRow ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}
              aria-label={t('detail.editSupport', { customer: supportSubject(support) })}>
              <Pencil size={14} aria-hidden="true" />
            </button>
          ) : null}
          {canRemove ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}
              aria-label={t('detail.deleteSupport', { customer: supportSubject(support) })}>
              <Trash2 size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      <ConfirmModal isOpen={confirming} title={t('detail.deleteSupportTitle')} message={t('detail.deleteSupportMessage', { customer: supportSubject(support) })}
        confirmLabel={t('actions.delete')} isLoading={remove.isPending}
        onConfirm={() => remove.mutate(support.support_id)} onCancel={() => setConfirming(false)}>
        <WriteError error={remove.error} />
      </ConfirmModal>
    </li>
  )
}
