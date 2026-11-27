/**
 * @fileoverview The Product tab's proposal (7.104.00): `GET …/product-proposals/latest` (the open or latest proposal,
 * each field's current value and whether it changed since the extract, who wrote each field, the sources), its
 * accept and its dismiss. The server is the guard: an accept writes a field only while it still holds the value the
 * proposal was seen against, so after any answer the proposal and the form's shared context are read again. A new
 * proposal (another `proposal_id`) clears the last accept's and dismiss's outcome; a refusal because the proposal had
 * closed meanwhile (`closed`) is kept here, outside the review, which that read replaces or removes. A failed read
 * of the latest proposal is `isError`, never an empty state.
 *
 * @module pages/ProjectDetail/useProductProposal
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { PRODUCT_CONTEXT_FIELDS } from '../../api/productSourcesSchema'
import { apiErrorCode } from '../../lib/errors'
import { productQuestionKey } from './productContextFields'
import { productContextKey } from './useProjectData'
import type {
  AcceptProductProposalBody, ProductContext, ProductContextField, ProductProposal, ProductProposalLatest,
} from '../../api/projectTypes'

/** The latest proposal's query key: the Extract invalidates it when its job completes. */
export const productProposalKey = (projectId: string) => ['product-proposal', projectId] as const

/** The accept's or the dismiss's 409 for a proposal no longer open (shared/product_proposals.py
 * `PROPOSAL_CLOSED_MESSAGE`): a newer extract replaced it, it was dismissed, or every field was applied. */
const PROPOSAL_CLOSED = 'proposal_closed'

export function useProductProposal(projectId: string) {
  const queryClient = useQueryClient()
  const latest = useQuery({
    queryKey: productProposalKey(projectId),
    queryFn: () => projectsApi.getLatestProductProposal(projectId),
    retry: false,
  })
  // "The proposal closed" (an accept's or a dismiss's 409 proposal_closed), kept here, not on the mutation: the answer
  // reads the proposal again first, so the review that would say it is gone (dismissed, applied) or new (superseded),
  // and a new proposal id resets the mutations. The id is the latest proposal's after that read ('' for none): the
  // notice stays while that one is shown, until the next accept or dismiss.
  const [closedOn, setClosedOn] = useState<string | null>(null)
  const latestId = () =>
    queryClient.getQueryData<ProductProposalLatest>(productProposalKey(projectId))?.proposal?.proposal_id ?? ''
  const reread = async (_data: unknown, error: unknown) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: productProposalKey(projectId) }),
      queryClient.invalidateQueries({ queryKey: productContextKey(projectId) }),
    ])
    if (apiErrorCode(error) === PROPOSAL_CLOSED) setClosedOn(latestId())
  }
  const proposalId = latest.data?.proposal?.proposal_id ?? ''
  const accept = useMutation({
    mutationFn: (body: AcceptProductProposalBody) => projectsApi.acceptProductProposal(projectId, proposalId, body),
    onMutate: () => setClosedOn(null),
    // A 409 (every field changed) or a partial answer alike: the rows show the values as they are now.
    onSettled: reread,
  })
  const dismiss = useMutation({
    mutationFn: () => projectsApi.dismissProductProposal(projectId, proposalId),
    onMutate: () => setClosedOn(null),
    onSettled: reread,
  })
  // An accept's or a dismiss's outcome is about the proposal it was made on: a newer proposal starts with none.
  const { reset: resetAccept } = accept
  const { reset: resetDismiss } = dismiss
  useEffect(() => {
    resetAccept()
    resetDismiss()
  }, [proposalId, resetAccept, resetDismiss])
  return {
    latest: latest.data,
    loading: latest.isLoading,
    /** The latest proposal could not be read, and nothing was read before (not an empty state). */
    isError: latest.isError && latest.data === undefined,
    retry: () => { void latest.refetch() },
    retrying: latest.isFetching,
    /** The last accept or dismiss was refused because the proposal had closed meanwhile. */
    closed: closedOn !== null && closedOn === proposalId,
    accept,
    dismiss,
  }
}

export type ProductProposalState = ReturnType<typeof useProductProposal>

/** One question of the gaps panel. */
export interface GapQuestion {
  readonly field: ProductContextField
  readonly question: string
}

/** The first question of each field, in their order: the panel answers a field once (its answers are keyed by field),
 * as the voice start asks it once; a proposal stored before its extract kept one a field may hold two. */
function firstPerField(questions: readonly GapQuestion[]): readonly GapQuestion[] {
  const seen = new Set<ProductContextField>()
  return questions.filter((one) => {
    if (seen.has(one.field)) return false
    seen.add(one.field)
    return true
  })
}

/** The gaps panel's questions: an open proposal's own (one a field), else a default one for each empty field. */
export function useGapQuestions(proposal: ProductProposal | null, context: ProductContext): readonly GapQuestion[] {
  const { t } = useTranslation('projectDetail')
  return useMemo(() => {
    if (proposal !== null && proposal.questions.length > 0) return firstPerField(proposal.questions)
    const empty = PRODUCT_CONTEXT_FIELDS.filter((field) => context[field].trim() === '')
    return empty.map((field) => ({ field, question: t(productQuestionKey(field)) }))
  }, [proposal, context, t])
}
