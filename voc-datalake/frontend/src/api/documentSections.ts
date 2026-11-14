/**
 * @fileoverview The project's four document sections (docs/prototype-builder.md "Part 4"), in their one order.
 *
 * The section is a pure function of `document_type`, the same table as the server's
 * `lambda/shared/document_sections.py` and the stream's `document-sections.ts`: PRD, PR/FAQ, Prototypes, and
 * Documents for everything else (research, custom, product reports, decisions and any type added later). The
 * project read sends it as `section`; a document without one (an older API, a document built in the page) falls
 * back to the table.
 *
 * @module api/documentSections
 */
import type { KnownProjectDocumentType } from './types'

/** The sections, in the order every list shows them. */
export const DOCUMENT_SECTIONS = ['prd', 'prfaq', 'prototypes', 'documents'] as const

export type DocumentSectionId = (typeof DOCUMENT_SECTIONS)[number]

/** Every type the SPA knows, keyed so a type added to `KnownProjectDocumentType` does not compile until it has a section. */
const SECTION_OF_TYPE: Readonly<Record<KnownProjectDocumentType, DocumentSectionId>> = {
  prd: 'prd',
  prfaq: 'prfaq',
  prototype: 'prototypes',
  research: 'documents',
  custom: 'documents',
  product_report: 'documents',
  decision: 'documents',
}

const SECTION_IDS: ReadonlySet<string> = new Set(DOCUMENT_SECTIONS)

function isDocumentSection(value: unknown): value is DocumentSectionId {
  return typeof value === 'string' && SECTION_IDS.has(value)
}

/** The section of a `document_type`: non-strings and unknown types are Documents. */
export function documentSection(documentType: unknown): DocumentSectionId {
  // Own keys only: "constructor" or "toString" is an unknown type, not a lookup on the prototype.
  if (typeof documentType !== 'string' || !Object.hasOwn(SECTION_OF_TYPE, documentType)) return 'documents'
  const table: Readonly<Record<string, DocumentSectionId>> = SECTION_OF_TYPE
  return table[documentType] ?? 'documents'
}

/** What the section of a row is read from. */
export interface SectionedDocument {
  readonly document_type: string
  readonly section?: string
}

/** The row's own `section` when it names one, else the table's answer for its type. */
export function sectionOf(document: SectionedDocument): DocumentSectionId {
  return isDocumentSection(document.section) ? document.section : documentSection(document.document_type)
}

/** What newest-first reads of a row. */
export interface DatedDocument {
  readonly document_id: string
  readonly created_at?: string
  readonly updated_at?: string
}

/** The date newest-first sorts on, and the one a list row shows: `updated_at`, else `created_at`. */
export function lastEdit(document: DatedDocument): string {
  return document.updated_at !== undefined && document.updated_at !== '' ? document.updated_at : (document.created_at ?? '')
}

/** Newest first by last edit (`updated_at`, else `created_at`); ties by `document_id`, so the order is stable. */
export function byNewestEdit(a: DatedDocument, b: DatedDocument): number {
  return lastEdit(b).localeCompare(lastEdit(a)) || a.document_id.localeCompare(b.document_id)
}

export interface DocumentSectionGroup<T> {
  readonly section: DocumentSectionId
  readonly documents: T[]
}

/** All four sections in order (empty ones kept), each with its documents in the order given. */
export function groupBySection<T extends SectionedDocument>(documents: readonly T[]): DocumentSectionGroup<T>[] {
  const groups = DOCUMENT_SECTIONS.map((section): DocumentSectionGroup<T> => ({ section, documents: [] }))
  for (const document of documents) {
    groups[DOCUMENT_SECTIONS.indexOf(sectionOf(document))]?.documents.push(document)
  }
  return groups
}
