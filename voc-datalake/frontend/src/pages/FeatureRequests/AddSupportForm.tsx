/**
 * @fileoverview "+1" (with my customer, on a sales board): a collapsed button that opens the
 * board's supporter fields.
 *
 * @module pages/FeatureRequests/AddSupportForm
 */
import { ThumbsUp } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { emptySupportDraft, rememberName, supportSpecOf, supportValuesOf } from './boardFormat'
import { useCurrentBoard } from './boardContext'
import { PLUS_ONE_LABELS } from './boardLabels'
import SupportFields from './SupportFields'
import WriteError from './WriteError'
import { useBoardWrite } from './useBoardQueries'
import { useSupportDraft } from './useSupportDraft'
import type { SupportInput } from '../../api/featureRequestsApi'

export default function AddSupportForm({ requestId, initialName }: Readonly<{ requestId: string; initialName: string }>) {
  const { t } = useTranslation('featureRequests')
  const board = useCurrentBoard()
  const spec = supportSpecOf(board.fields, 'support')
  const plusOne = t(PLUS_ONE_LABELS[board.template].labelKey)
  const [open, setOpen] = useState(false)
  const form = useSupportDraft(emptySupportDraft(initialName, spec), spec)
  const add = useBoardWrite(
    (api, input: SupportInput) => api.addSupport(requestId, input),
    () => {
      form.reset(emptySupportDraft(form.draft.name, spec))
      setOpen(false)
    },
  )
  if (!open) {
    return (
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
        <ThumbsUp size={14} aria-hidden="true" />{plusOne}
      </button>
    )
  }
  return (
    <form className="card p-3 space-y-3" noValidate aria-label={plusOne} onSubmit={(e) => {
      e.preventDefault()
      if (!form.attempt()) return
      rememberName(form.draft.name)
      add.mutate({ name: form.draft.name.trim(), fields: supportValuesOf(form.draft, spec) })
    }}>
      <h3 className="text-sm font-medium text-text">{plusOne}</h3>
      <SupportFields draft={form.draft} errors={form.errors} spec={spec} onChange={form.setDraft} />
      <WriteError error={add.error} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>{t('actions.cancel')}</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={add.isPending}>{t('detail.addSupport')}</button>
      </div>
    </form>
  )
}
