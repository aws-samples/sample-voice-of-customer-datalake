/**
 * @fileoverview Words for an Insights status row. One board: that board's own label for the key
 * (`statusLabel`, translated while it is a template default). Every board: the first board that
 * has the key, else the key humanized.
 *
 * @module pages/FeatureRequests/insightLabels
 */
import { humanizeId } from '../../utils/displayLabels'
import { statusLabel } from './boardStatuses'
import type { FeatureBoard } from '../../api/featureBoardsSchema'

export function insightStatusLabel(key: string, boards: readonly FeatureBoard[], t: (key: string) => string): string {
  for (const board of boards) {
    const status = board.statuses.find((candidate) => candidate.key === key)
    if (status !== undefined) return statusLabel(status, t)
  }
  return humanizeId(key)
}
