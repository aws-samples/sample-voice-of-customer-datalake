/**
 * @fileoverview What tells one project document type from another: its lucide icon
 * and its label — never a tone.
 *
 * Labels vs status (docs/kiro-design-system.md, rule 15): a document TYPE says which
 * one, never how it is, so every type is the same `badge-muted` pill and the icon +
 * text distinguish a PRD from a PR/FAQ. Before 3.14.02 the Documents rail, the lineage
 * footers, the Prioritization rows and the wizard's document picker each kept their
 * own type → tone map (PRD info, PR/FAQ ok, research warn, custom aim, report accent,
 * prototype warn) — six tones for six kinds, next to the row's real state.
 *
 * Where the workflow editor already draws a type (`NodeTypeIcon`: write_prd FileText,
 * write_prfaq Newspaper, build_prototype Hammer, revise_document FilePen) the same
 * glyph is used, so a document and the step that writes it match.
 * @module components/DocumentTypeBadge/documentTypes
 */
import { File, FileBarChart, FilePen, FileText, Hammer, Newspaper, Scale, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { KnownProjectDocumentType } from '../../api/types'

const DOCUMENT_TYPE_ICONS: Readonly<Record<KnownProjectDocumentType, LucideIcon>> = {
  prd: FileText,
  prfaq: Newspaper,
  research: Search,
  custom: FilePen,
  product_report: FileBarChart,
  prototype: Hammer,
  decision: Scale,
}

/** `Object.hasOwn`, so an inherited name such as `constructor` never answers. */
function isKnownDocumentType(type: string): type is KnownProjectDocumentType {
  return Object.hasOwn(DOCUMENT_TYPE_ICONS, type)
}

/** The icon of a document type; a generic file for a type this build does not know. */
export function documentTypeIcon(type: string): LucideIcon {
  return isKnownDocumentType(type) ? DOCUMENT_TYPE_ICONS[type] : File
}

/** The wire type as its label: `product_report` → "PRODUCT REPORT". */
export function documentTypeLabel(type: string): string {
  return type.toUpperCase().replaceAll('_', ' ')
}
