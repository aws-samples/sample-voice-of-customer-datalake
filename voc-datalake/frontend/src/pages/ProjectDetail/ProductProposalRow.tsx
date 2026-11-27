/**
 * @fileoverview One field of the Product tab's proposal review (7.104.00): its current value and who wrote it ("typed
 * by you", by a teammate, from an extract, from the assistant), the proposed value (editable before accept), the
 * confidence, the citations (the source's name, the page, the quote; a quote not found in its source is marked, so
 * is a source deleted since) and the checkbox. A field changed since the extract says so: Accept all leaves it out,
 * and its own accept is made against its new value.
 *
 * @module pages/ProjectDetail/ProductProposalRow
 */
import { useId } from 'react'
import clsx from 'clsx'
import { CheckCircle2, Quote } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LIFECYCLE_STATES, PRODUCT_CONTEXT_STRING_FIELDS } from '@stream/assistant/tools/client/allowlists'
import { useMySub } from '../../store/authStore'
import { productFieldLabelKey } from './productContextFields'
import { proposalRowId } from './productProposalModel'
import type {
  ProductContextField, ProductFieldMeta, ProductFieldProposal, ProductProposalCitation, ProductProposalSource,
} from '../../api/projectTypes'

const CONFIDENCE_BADGE = { high: 'badge-ok', medium: 'badge-muted', low: 'badge-warn' } as const

function useByLabel(meta: ProductFieldMeta | undefined): string | null {
  const { t } = useTranslation('projectDetail')
  const mySub = useMySub()
  if (meta === undefined) return null
  if (meta.by === 'person') return t(meta.sub === mySub ? 'product.review.by.you' : 'product.review.by.teammate')
  return t(meta.by === 'extract' ? 'product.review.by.extract' : 'product.review.by.assistant')
}

function CitationLine({ citation, source }: Readonly<{ citation: ProductProposalCitation; source: ProductProposalSource | undefined }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <li className="flex items-start gap-1.5 text-xs text-muted">
      <Quote size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        <span className="font-medium text-text">{source?.name ?? citation.source_id}</span>
        {citation.page === null ? null : <span>{' · '}{t('product.review.page', { page: citation.page })}</span>}
        {source?.deleted === true ? <span className="text-warn">{' · '}{t('product.review.sourceDeleted')}</span> : null}
        {citation.quote === '' ? null : <span className="block italic">“{citation.quote}”</span>}
        {citation.verified ? null : <span className="text-warn">{t('product.review.unverified')}</span>}
      </span>
    </li>
  )
}

function ValueEditor({ field, value, label, onEdit }: Readonly<{
  field: ProductContextField; value: string; label: string; onEdit: (value: string) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const id = useId()
  const control = field === 'current_state' ? (
    <select id={id} className="input w-full" value={value} onChange={(event) => onEdit(event.target.value)}>
      {LIFECYCLE_STATES.map((state) => <option key={state} value={state}>{t(`product.lifecycle.${state}`)}</option>)}
    </select>
  ) : (
    <textarea id={id} rows={3} className="input w-full resize-y" value={value} maxLength={PRODUCT_CONTEXT_STRING_FIELDS[field]}
      onChange={(event) => onEdit(event.target.value)} />
  )
  return <><label htmlFor={id} className="sr-only">{t('product.review.editLabel', { field: label })}</label>{control}</>
}

/** How a value reads: its text, a lifecycle state by its name, or "(empty)". */
function useShownValue() {
  const { t } = useTranslation('projectDetail')
  return (field: ProductContextField, value: string): string => {
    if (value === '') return t('product.review.empty')
    return field === 'current_state' ? t(`product.lifecycle.${value}`, { defaultValue: value }) : value
  }
}

export interface RowChoice {
  readonly selected: boolean
  readonly edited: string
  readonly onSelect: (selected: boolean) => void
  readonly onEdit: (value: string) => void
}

export default function ProductProposalRow({ field, proposal, meta, sources, choice }: Readonly<{
  field: ProductContextField
  proposal: ProductFieldProposal
  meta: ProductFieldMeta | undefined
  sources: readonly ProductProposalSource[]
  /** Null for a viewer, and for a row already accepted. */
  choice: RowChoice | null
}>) {
  const { t } = useTranslation('projectDetail')
  const label = t(productFieldLabelKey(field))
  const by = useByLabel(meta)
  const shown = useShownValue()
  const verified = proposal.citations.some((citation) => citation.verified)
  return (
    <li id={proposalRowId(field)} className="scroll-mt-24 space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {choice === null ? null : (
          <input type="checkbox" checked={choice.selected} aria-label={t('product.review.select', { field: label })}
            onChange={(event) => choice.onSelect(event.target.checked)} />
        )}
        <span className="text-sm font-medium text-text-strong">{label}</span>
        <span className={clsx('badge', CONFIDENCE_BADGE[proposal.confidence])}>{t(`product.review.confidence.${proposal.confidence}`)}</span>
        {verified ? null : <span className="badge badge-warn">{t('product.review.noVerified')}</span>}
        {proposal.accepted ? <span className="badge badge-ok"><CheckCircle2 size={12} aria-hidden="true" />{t('product.review.accepted')}</span> : null}
      </div>
      {proposal.changed_since && !proposal.accepted ? <p className="text-xs text-warn">{t('product.review.changed')}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <p className="text-[12px] font-medium text-muted">{t('product.review.current')}{by === null ? '' : ` · ${by}`}</p>
          <p className="whitespace-pre-wrap text-sm text-text">{shown(field, proposal.current)}</p>
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-[12px] font-medium text-muted">{t('product.review.proposed')}</p>
          {choice === null
            ? <p className="whitespace-pre-wrap text-sm text-text">{shown(field, proposal.value)}</p>
            : <ValueEditor field={field} value={choice.edited} label={label} onEdit={choice.onEdit} />}
        </div>
      </div>
      {proposal.note === '' ? null : <p className="text-xs text-muted">{proposal.note}</p>}
      {proposal.citations.length === 0 ? null : (
        <ul aria-label={t('product.review.citations')} className="space-y-1">
          {proposal.citations.map((citation, index) => (
            <CitationLine key={`${citation.source_id}-${String(index)}`} citation={citation}
              source={sources.find((source) => source.source_id === citation.source_id)} />
          ))}
        </ul>
      )}
    </li>
  )
}
