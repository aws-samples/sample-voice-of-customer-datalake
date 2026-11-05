/**
 * @fileoverview Feedback-board requests as a wizard evidence source: the boards a
 * person may pick from (the board pages' own cached listing, archived boards left out) and the fields
 * a generation request carries for them. Requests stay their own source: they are never added to the
 * review filters or counts.
 *
 * @module components/DataSourceWizard/featureRequestEvidence
 */
import { useQuery } from '@tanstack/react-query'
import { appFeatureRequestsApi, featureRequestKeys } from '../../api/featureRequestsApi'
import { MAX_EVIDENCE_BOARDS } from './types'
import type { ContextConfig } from './types'
import type { FeatureBoard } from '../../api/featureBoardsSchema'

/** The non-archived boards this person may use, read only while `enabled` (the box is ticked). */
export function useEvidenceBoards(enabled: boolean): { boards: readonly FeatureBoard[]; isLoading: boolean; isError: boolean } {
  const query = useQuery({
    queryKey: featureRequestKeys.boards('app'),
    queryFn: () => appFeatureRequestsApi.listBoards(),
    enabled,
  })
  const boards = (query.data?.boards ?? []).filter((board) => !board.archived)
  return { boards, isLoading: enabled && query.isLoading, isError: query.isError }
}

/**
 * The persona / research run's body fields: nothing unless the box is ticked (the API's default is off).
 * Not for `feedback-preview`, which counts reviews only (the board count comes from the Insights route).
 */
export function featureRequestEvidenceFields(config: Pick<ContextConfig, 'useFeatureRequests' | 'featureRequestBoardIds'>): {
  include_feature_requests?: true
  feature_request_board_ids?: string[]
} {
  if (!config.useFeatureRequests) return {}
  const boardIds = config.featureRequestBoardIds.slice(0, MAX_EVIDENCE_BOARDS)
  return boardIds.length === 0
    ? { include_feature_requests: true }
    : { include_feature_requests: true, feature_request_board_ids: boardIds }
}

/** The document body's board ids (top level), only when requests are used and narrowed to some boards. */
export function documentBoardIds(config: Pick<ContextConfig, 'useFeatureRequests' | 'featureRequestBoardIds'>): {
  feature_request_board_ids?: string[]
} {
  const ids = featureRequestEvidenceFields(config).feature_request_board_ids
  return ids === undefined ? {} : { feature_request_board_ids: ids }
}
