import clsx from 'clsx'
import type { KnownProjectDocumentType } from '../../api/types'
import type { DocumentOrdinal } from '../../api/documentLineage'

type TFunc = (key: string, opts?: Record<string, unknown>) => string

const DOCUMENT_TYPE_STYLES: Record<KnownProjectDocumentType, string> = {
  prd: 'bg-blue-100 text-blue-700',
  prfaq: 'bg-green-100 text-green-700',
  research: 'bg-amber-100 text-amber-700',
  custom: 'bg-purple-100 text-purple-700',
  product_report: 'bg-indigo-100 text-indigo-700',
  prototype: 'bg-orange-100 text-orange-700',
}

function isKnownDocumentType(type: string): type is KnownProjectDocumentType {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_TYPE_STYLES, type)
}

/**
 * "2 of 3" for a document whose type has more than one.
 *
 * Silent for a type with a single document: "1 of 1" is noise on every PRD in
 * every project that has one, and the number only earns its space once there is
 * something to confuse it with.
 */
export function DocumentOrdinalLabel({
  ordinal, t,
}: {
  readonly ordinal: DocumentOrdinal | undefined
  readonly t: TFunc
}) {
  if (ordinal === undefined || ordinal.total < 2) return null

  return (
    <span className="text-xs font-medium text-gray-500 flex-shrink-0">
      {t('projectDetail:documents.ordinal', { ordinal: ordinal.ordinal, total: ordinal.total })}
    </span>
  )
}

export function DocumentTypeBadge({ type }: { readonly type: string }) {
  const style = isKnownDocumentType(type)
    ? DOCUMENT_TYPE_STYLES[type]
    : 'bg-amber-100 text-amber-700'

  return (
    <span className={clsx('text-xs font-medium px-2 py-0.5 rounded', style)}>
      {type.toUpperCase().replace('_', ' ')}
    </span>
  )
}
