/**
 * @fileoverview A project document's type as a neutral pill with the type's icon
 * (see documentTypes.ts for why it is never toned).
 * @module components/DocumentTypeBadge
 */
import { IconGlyph } from '../SourceIcon/SourceIcon'
import { documentTypeIcon, documentTypeLabel } from './documentTypes'

export function DocumentTypeBadge({ type, label }: {
  readonly type: string
  /** A resolved (translated) label; defaults to the wire type spelled out, "PRODUCT REPORT". */
  readonly label?: string
}) {
  return (
    <span className="badge badge-muted">
      <IconGlyph icon={documentTypeIcon(type)} size={12} />
      {label ?? documentTypeLabel(type)}
    </span>
  )
}
