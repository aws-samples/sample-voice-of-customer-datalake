import type { DocumentOrdinal } from '../../api/documentLineage'

type TFunc = (key: string, opts?: Record<string, unknown>) => string

/**
 * "2 of 3" for a document whose type has more than one.
 *
 * Silent for a type with a single document: "1 of 1" is noise on every PRD in
 * every project that has one, and the number only earns its space once there is
 * something to confuse it with.
 *
 * The type pill beside it is `components/DocumentTypeBadge` (shared with the
 * wizard's document picker and the lineage footers).
 */
export function DocumentOrdinalLabel({
  ordinal, t,
}: {
  readonly ordinal: DocumentOrdinal | undefined
  readonly t: TFunc
}) {
  if (ordinal === undefined || ordinal.total < 2) return null

  return (
    <span className="text-xs font-medium text-muted flex-shrink-0">
      {t('projectDetail:documents.ordinal', { ordinal: ordinal.ordinal, total: ordinal.total })}
    </span>
  )
}
