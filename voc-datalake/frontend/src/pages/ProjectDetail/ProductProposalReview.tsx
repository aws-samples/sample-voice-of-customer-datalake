/**
 * @fileoverview The Product tab's proposal review (7.104.00, docs/project-workspace.md → Product tab), full width
 * above the form while a proposal is open: its fields grouped as Proposed, Conflicts, Gaps and Unchanged, each with
 * its current and proposed value side by side and its citations, and "Accept selected", "Accept all proposed" and
 * "Dismiss". Nothing is written without an accept, and an accept writes a field only while it still holds the value
 * the proposal was made against (`seen`): the server is the guard. Accept all takes the proposed rows only, and
 * leaves out a field changed since the extract; a conflict (a value a person typed that a source contradicts) and a
 * changed field are accepted only when selected on their own (a changed one against its new value), and a selected row
 * that changed since its selection is unselected until the person selects it again. A proposal a newer extract
 * replaced, or that was dismissed meanwhile, is said by the Product tab in words of its own. A viewer reads the
 * review, and accepts nothing.
 *
 * @module pages/ProjectDetail/ProductProposalReview
 */
import { useId, useState } from 'react'
import { CheckCheck, Loader2, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PRODUCT_CONTEXT_FIELDS } from '../../api/productSourcesSchema'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { ApiError, apiErrorCode } from '../../lib/errors'
import { formatDateTime } from '../../utils/dateUtils'
import { productFieldLabelKey } from './productContextFields'
import ProductProposalRow from './ProductProposalRow'
import { acceptAllFields, acceptBody, isAcceptable } from './productProposalModel'
import type {
  AcceptProductProposalResult, ProductContextField, ProductProposal, ProductProposalLatest,
} from '../../api/projectTypes'
import type { ProductProposalState } from './useProductProposal'
import type { RowChoice } from './ProductProposalRow'

type Group = 'proposed' | 'conflict' | 'gap' | 'unchanged'
const GROUPS: readonly Group[] = ['proposed', 'conflict', 'gap', 'unchanged']

const HTTP_CONFLICT = 409
/** The accept's or the dismiss's 409 for a proposal no longer open: the Product tab says it, outside the review, which
 * the answer's read of the proposal replaces or removes (useProductProposal `closed`). */
const PROPOSAL_CLOSED = 'proposal_closed'

/** What the review says of a failed accept or dismiss: every selected field changed since the extract (an accept's 409
 * `conflict`), or a failure worth another try; nothing for a proposal that closed meanwhile (the tab says it). */
function failureKey(error: unknown, action: 'accept' | 'dismiss'): string | null {
  if (apiErrorCode(error) === PROPOSAL_CLOSED) return null
  if (action === 'dismiss') return 'product.review.result.dismissFailed'
  return error instanceof ApiError && error.status === HTTP_CONFLICT ? 'product.review.result.allChanged' : 'product.review.result.failed'
}

function AcceptOutcome({ result, error, dismissError }: Readonly<{
  result: AcceptProductProposalResult | undefined; error: unknown; dismissError: unknown
}>) {
  const { t } = useTranslation('projectDetail')
  if (error !== null || dismissError !== null) {
    const key = error === null ? failureKey(dismissError, 'dismiss') : failureKey(error, 'accept')
    return key === null ? null : <p role="alert" className="text-xs text-warn">{t(key)}</p>
  }
  if (result === undefined) return null
  return (
    <div role="status" className="space-y-0.5 text-xs">
      <p className="text-ok">{t('product.review.result.applied', { count: result.applied.length })}</p>
      {result.conflicts.map((conflict) => (
        <p key={conflict.field} className="text-warn">
          {t(conflict.reason === 'changed' ? 'product.review.result.changed' : 'product.review.result.personValue',
            { field: t(productFieldLabelKey(conflict.field)) })}
        </p>
      ))}
    </div>
  )
}

function ReviewActions({ proposal, selected, edits, state }: Readonly<{
  proposal: ProductProposal
  selected: readonly ProductContextField[]
  edits: Partial<Record<ProductContextField, string>>
  state: ProductProposalState
}>) {
  const { t } = useTranslation('projectDetail')
  const all = acceptAllFields(proposal)
  const busy = state.accept.isPending || state.dismiss.isPending
  return (
    <StickyActionBar variant="footer" className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || selected.length === 0}
        onClick={() => state.accept.mutate(acceptBody(proposal, selected, edits))}>
        {state.accept.isPending ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCheck size={14} aria-hidden="true" />}
        {t('product.review.acceptSelected')}
      </button>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || all.length === 0}
        onClick={() => state.accept.mutate(acceptBody(proposal, all, edits))}>
        {t('product.review.acceptAll')}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => state.dismiss.mutate()}>
        <X size={14} aria-hidden="true" />{t('product.review.dismiss')}
      </button>
    </StickyActionBar>
  )
}

/** A row's selection and the field's value when it was made (`current`). */
interface Selection {
  readonly selected: boolean
  readonly against: string
}

/** The rows' choices, kept per proposal (the body is keyed by its id): selected by default when Accept all takes the
 * row (proposed and unchanged); a conflict starts unselected. A selection holds only for the value the field had when
 * it was made: a row whose field changed since (someone typed in the form, and the proposal was read again) reads
 * unselected until the person selects it again, so Accept selected never writes over a value nobody chose to replace. */
function useChoices(proposal: ProductProposal) {
  const [selection, setSelection] = useState<Partial<Record<ProductContextField, Selection>>>(() => {
    const initial: Partial<Record<ProductContextField, Selection>> = {}
    for (const field of acceptAllFields(proposal)) initial[field] = { selected: true, against: proposal.fields[field].current }
    return initial
  })
  const [edits, setEdits] = useState<Partial<Record<ProductContextField, string>>>({})
  const isSelected = (field: ProductContextField): boolean => {
    const one = selection[field]
    return one?.selected === true && one.against === proposal.fields[field].current
  }
  const choiceOf = (field: ProductContextField): RowChoice => ({
    selected: isSelected(field),
    edited: edits[field] ?? proposal.fields[field].value,
    onSelect: (value) => setSelection((current) => ({ ...current, [field]: { selected: value, against: proposal.fields[field].current } })),
    onEdit: (value) => setEdits((current) => ({ ...current, [field]: value })),
  })
  const selected = PRODUCT_CONTEXT_FIELDS.filter((field) => isSelected(field) && isAcceptable(proposal, field))
  return { choiceOf, selected, edits }
}

function ReviewBody({ latest, proposal, state, canEdit }: Readonly<{
  latest: ProductProposalLatest; proposal: ProductProposal; state: ProductProposalState; canEdit: boolean
}>) {
  const { t } = useTranslation('projectDetail')
  const { choiceOf, selected, edits } = useChoices(proposal)
  const groupOf = (field: ProductContextField): Group => proposal.fields[field].status
  return (
    <>
      {GROUPS.map((group) => {
        const fields = PRODUCT_CONTEXT_FIELDS.filter((field) => groupOf(field) === group)
        if (fields.length === 0) return null
        if (group === 'unchanged' || group === 'gap') {
          return (
            <div key={group} className="space-y-1">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{t(`product.review.groups.${group}`)}</h4>
              <p className="text-sm text-text">{fields.map((field) => t(productFieldLabelKey(field))).join(' · ')}</p>
              {group === 'gap' ? <p className="text-xs text-muted">{t('product.review.gapNote')}</p> : null}
            </div>
          )
        }
        return (
          <div key={group} className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{t(`product.review.groups.${group}`)}</h4>
            <ul className="space-y-2">
              {fields.map((field) => (
                <ProductProposalRow key={field} field={field} proposal={proposal.fields[field]} meta={latest.field_meta[field]}
                  sources={proposal.sources} choice={canEdit && isAcceptable(proposal, field) ? choiceOf(field) : null} />
              ))}
            </ul>
          </div>
        )
      })}
      {canEdit ? (
        <div className="space-y-2 border-t border-border pt-3">
          <ReviewActions proposal={proposal} selected={selected} edits={edits} state={state} />
          <AcceptOutcome result={state.accept.data} error={state.accept.error} dismissError={state.dismiss.error} />
        </div>
      ) : <p className="text-xs text-muted">{t('product.review.readOnly')}</p>}
    </>
  )
}

/** The ready sources this extract did not read (added or read since): extract again to use them. */
function NewSourcesNote({ latest, proposal }: Readonly<{ latest: ProductProposalLatest; proposal: ProductProposal }>) {
  const { t } = useTranslation('projectDetail')
  const read = new Set([...proposal.sources, ...proposal.skipped_sources].map((source) => source.doc_id))
  const added = latest.sources.filter((doc) => doc.status === 'ready' && !read.has(doc.doc_id)).length
  return added === 0 ? null : <p className="text-[12px] text-muted">{t('product.review.newSources', { count: added })}</p>
}

export default function ProductProposalReview({ latest, proposal, state, canEdit }: Readonly<{
  latest: ProductProposalLatest
  proposal: ProductProposal
  state: ProductProposalState
  canEdit: boolean
}>) {
  const { t, i18n } = useTranslation('projectDetail')
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="card space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold tracking-tight text-text-strong">
          <Sparkles size={16} className="flex-shrink-0 text-accent" aria-hidden="true" />{t('product.review.title')}
          {proposal.status === 'partly_applied' ? <span className="badge badge-info">{t('product.review.partlyApplied')}</span> : null}
        </h3>
        <p className="text-[12px] text-muted">
          {t('product.review.subtitle', { count: proposal.sources.length, at: formatDateTime(proposal.created_at, i18n.language, proposal.created_at) })}
        </p>
        <NewSourcesNote latest={latest} proposal={proposal} />
        {proposal.skipped_sources.length > 0 ? (
          <p className="text-[12px] text-warn">{t('product.review.skipped', {
            count: proposal.skipped_sources.length, names: proposal.skipped_sources.map((source) => source.name).join(', '),
          })}</p>
        ) : null}
      </div>
      <ReviewBody key={proposal.proposal_id} latest={latest} proposal={proposal} state={state} canEdit={canEdit} />
    </section>
  )
}
