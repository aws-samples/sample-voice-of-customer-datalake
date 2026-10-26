/**
 * @fileoverview Create or edit a decision record: verdict, rationale, how success is
 * measured, when to stop, dates and the evidence (feedback ids, project documents).
 * @module pages/ProjectDetail/decisions/DecisionForm
 */
import { Loader2 } from 'lucide-react'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { VERDICTS } from '../../../api/decisionSchema'
import type { ProjectDocument } from '../../../api/types'
import { draftToInput, isSubmittable } from './decisionDraft'
import ReviewSearchPicker from './ReviewSearchPicker'
import type { DecisionDraft } from './decisionDraft'
import type { DecisionInput } from '../../../api/decisionsApi'

const HTTP_CONFLICT = 409

interface DecisionFormProps {
  readonly initial: DecisionDraft
  /** Documents that may be cited (the decision itself excluded by the caller). */
  readonly documents: readonly ProjectDocument[]
  readonly isSaving: boolean
  readonly error: unknown
  readonly onSave: (input: DecisionInput) => void
  readonly onCancel: () => void
}

function Field({ label, children }: Readonly<{ label: string; children: (id: string) => ReactNode }>) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-text">{label}</label>
      {children(id)}
    </div>
  )
}

function VerdictPicker({ value, onChange }: Readonly<{ value: DecisionDraft['verdict']; onChange: (v: DecisionDraft['verdict']) => void }>) {
  const { t } = useTranslation('decisions')
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-text">{t('verdict.label')}</legend>
      <div className="flex flex-wrap gap-3">
        {VERDICTS.map((verdict) => (
          <label key={verdict} className="inline-flex items-center gap-2 text-sm">
            <input type="radio" name="verdict" value={verdict} checked={value === verdict} onChange={() => onChange(verdict)} />
            {t(`verdict.${verdict}`)}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function DocumentPicker({ documents, selected, onChange }: Readonly<{
  documents: readonly ProjectDocument[]; selected: readonly string[]; onChange: (ids: string[]) => void
}>) {
  const { t } = useTranslation('decisions')
  if (documents.length === 0) return null
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((d) => d !== id) : [...selected, id])
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-text">{t('fields.documents')}</legend>
      <div className="max-h-40 overflow-y-auto space-y-1">
        {documents.map((doc) => (
          <label key={doc.document_id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(doc.document_id)} onChange={() => toggle(doc.document_id)} />
            <span className="truncate">{doc.title}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function errorMessageKey(error: unknown): string | null {
  if (error === null || error === undefined) return null
  return apiErrorStatus(error) === HTTP_CONFLICT ? 'errors.conflict' : 'errors.save'
}

export default function DecisionForm({ initial, documents, isSaving, error, onSave, onCancel }: DecisionFormProps) {
  const { t } = useTranslation('decisions')
  const [draft, setDraft] = useState<DecisionDraft>(initial)
  const set = <K extends keyof DecisionDraft>(key: K, value: DecisionDraft[K]) => setDraft((prev) => ({ ...prev, [key]: value }))
  const errorKey = errorMessageKey(error)
  return (
    <form
      className="card p-4 space-y-4"
      aria-label={t('formLabel')}
      onSubmit={(event) => {
        event.preventDefault()
        if (isSubmittable(draft)) onSave(draftToInput(draft))
      }}
    >
      <Field label={t('fields.title')}>
        {(id) => <input id={id} className="input" value={draft.title} maxLength={200} required onChange={(e) => set('title', e.target.value)} />}
      </Field>
      <VerdictPicker value={draft.verdict} onChange={(v) => set('verdict', v)} />
      <Field label={t('fields.rationale')}>
        {(id) => <textarea id={id} className="input min-h-24" value={draft.rationale} maxLength={4000} required onChange={(e) => set('rationale', e.target.value)} />}
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={t('fields.successMetric')}>
          {(id) => <input id={id} className="input" value={draft.successMetric} maxLength={1000} onChange={(e) => set('successMetric', e.target.value)} />}
        </Field>
        <Field label={t('fields.killCriterion')}>
          {(id) => <input id={id} className="input" value={draft.killCriterion} maxLength={1000} onChange={(e) => set('killCriterion', e.target.value)} />}
        </Field>
        <Field label={t('fields.reviewBy')}>
          {(id) => <input id={id} type="date" className="input" value={draft.reviewBy} onChange={(e) => set('reviewBy', e.target.value)} />}
        </Field>
        <Field label={t('fields.launchedAt')}>
          {(id) => <input id={id} type="date" className="input" value={draft.launchedAt} onChange={(e) => set('launchedAt', e.target.value)} />}
        </Field>
      </div>
      <ReviewSearchPicker value={draft.feedbackIds} onChange={(ids) => set('feedbackIds', ids)} />
      <DocumentPicker documents={documents} selected={draft.documentIds} onChange={(ids) => set('documentIds', ids)} />
      {errorKey !== null && <p className="text-sm text-danger" role="alert">{t(errorKey)}</p>}
      <StickyActionBar variant="inline" className="flex justify-end gap-2 py-2">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('actions.cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={isSaving || !isSubmittable(draft)}>
          {isSaving && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t('actions.save')}
        </button>
      </StickyActionBar>
    </form>
  )
}
