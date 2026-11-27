/**
 * @fileoverview The Product tab's proposal review, as data (7.104.00): which rows an accept can take, what Accept all
 * takes, and the accept's body. Kept apart from the components so the rules are tested on their own.
 *
 * @module pages/ProjectDetail/productProposalModel
 */
import { PRODUCT_CONTEXT_FIELDS } from '../../api/productSourcesSchema'
import type { AcceptProductProposalBody, ProductContextField, ProductProposal } from '../../api/projectTypes'

/** A field's review row anchor, which the form's "Proposed" badge scrolls to. */
export const proposalRowId = (field: ProductContextField): string => `product-proposal-${field}`

/** A proposal the review offers to accept from (a dismissed, applied or superseded one is history). */
export const isReviewable = (status: string): boolean => status === 'open' || status === 'partly_applied'

/** A row an accept can still take: proposed or in conflict, not accepted yet. */
export function isAcceptable(proposal: ProductProposal, field: ProductContextField): boolean {
  const one = proposal.fields[field]
  return (one.status === 'proposed' || one.status === 'conflict') && !one.accepted
}

/** What Accept all takes: every proposed row not accepted yet and unchanged since the extract. A conflict (a value a
 * person typed that a source contradicts) is never replaced in bulk: it needs its own selection. */
export function acceptAllFields(proposal: ProductProposal): ProductContextField[] {
  return PRODUCT_CONTEXT_FIELDS.filter((field) => {
    const one = proposal.fields[field]
    return one.status === 'proposed' && !one.accepted && !one.changed_since
  })
}

/** The fields an open proposal proposes a value for, which the form badges "Proposed". */
export function proposedFields(proposal: ProductProposal | null): ReadonlySet<ProductContextField> {
  if (proposal === null || !isReviewable(proposal.status)) return new Set()
  return new Set(PRODUCT_CONTEXT_FIELDS.filter((field) => isAcceptable(proposal, field)))
}

/**
 * The accept's body: each field with the value it is accepted against (`seen`, or its new value once it changed since
 * the extract: the person chose it knowing) and its edited value when the person changed the proposed one.
 */
export function acceptBody(proposal: ProductProposal, fields: readonly ProductContextField[],
  edits: Partial<Record<ProductContextField, string>>): AcceptProductProposalBody {
  const body: AcceptProductProposalBody = { fields: {} }
  for (const field of fields) {
    const one = proposal.fields[field]
    const edited = edits[field]
    body.fields[field] = {
      seen: one.changed_since ? one.current : one.seen,
      ...(edited !== undefined && edited !== one.value ? { value: edited } : {}),
    }
  }
  return body
}
