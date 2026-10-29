/**
 * @fileoverview A board's statuses as the page shows them: which status a request is in (an unknown
 * key reads as the board's initial status, the first), its words and its tint.
 *
 * Status labels are the admin's own words, stored on the board. A template's untouched default
 * label (key and English label as the template made them) is shown translated instead, so a
 * seeded board reads in the visitor's language until an admin renames a status.
 *
 * @module pages/FeatureRequests/boardStatuses
 */
import { TEMPLATE_DEFAULTS } from '../../api/boardFields'
import type { BoardStatus } from '../../api/boardFields'
import type { FeatureBoard } from '../../api/featureBoardsSchema'
import { STATUS_LABELS } from './boardLabels'

/** The status of `key` on `board`; an unknown key reads as the initial status. */
export function boardStatusOf(board: FeatureBoard, key: string): BoardStatus {
  return board.statuses.find((status) => status.key === key) ?? board.statuses[0] ?? { key, label: key }
}

const DEFAULT_LABELS: ReadonlyMap<string, string> = new Map(
  Object.values(TEMPLATE_DEFAULTS).flatMap((template) => template.statuses.map((status) => [status.key, status.label] as const)),
)

/** The words for `status`: translated while it is a template default, the admin's label otherwise. */
export function statusLabel(status: BoardStatus, t: (key: string) => string): string {
  const labelKey = STATUS_LABELS[status.key]?.labelKey
  return labelKey !== undefined && DEFAULT_LABELS.get(status.key) === status.label ? t(labelKey) : status.label
}

const KEY_TINT: Readonly<Record<string, string | undefined>> = {
  new: 'badge-info',
  under_review: 'badge-warn',
  confirmed: 'badge-warn',
  seen: 'badge-warn',
  planned: 'badge-accent',
  shipped: 'badge-ok',
  fixed: 'badge-ok',
  done: 'badge-ok',
  declined: 'badge-muted',
  wont_fix: 'badge-muted',
}

const POSITION_TINTS = ['badge-info', 'badge-warn', 'badge-accent', 'badge-ok', 'badge-muted'] as const

/** A known key's tint; an admin's own status takes one by its position on the board. */
export function statusTint(board: FeatureBoard, key: string): string {
  const known = KEY_TINT[key]
  if (known !== undefined) return known
  const index = Math.max(0, board.statuses.findIndex((status) => status.key === key))
  return POSITION_TINTS[index % POSITION_TINTS.length] ?? 'badge-muted'
}
