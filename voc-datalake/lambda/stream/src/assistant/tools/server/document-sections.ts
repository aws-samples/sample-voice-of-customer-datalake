/**
 * The project's four document sections (docs/prototype-builder.md "Part 4"), in their one order: the same table as
 * `lambda/shared/document_sections.py` and the SPA's `frontend/src/api/documentSections.ts`.
 *
 * The project read carries each document's `section`; a row without a known one (an older API) falls back to the
 * table, by its `document_type`, else by the legacy sort key's prefix (`PRD#`, `PRFAQ#`, `PROTOTYPE#`), as the SPA
 * reads it. Non-strings and unknown types are Documents. Within a section, last edit first (`updated_at`, else
 * `created_at`; ties by `document_id`), the project page's order.
 */

export const SECTION_ORDER = ['prd', 'prfaq', 'prototypes', 'documents'] as const;

export type DocumentSection = (typeof SECTION_ORDER)[number];

const SECTION_OF_TYPE: Readonly<Record<string, DocumentSection>> = {
  prd: 'prd',
  prfaq: 'prfaq',
  prototype: 'prototypes',
  research: 'documents',
  custom: 'documents',
  product_report: 'documents',
  decision: 'documents',
};

const SECTIONS: ReadonlySet<string> = new Set(SECTION_ORDER);

function isSection(value: unknown): value is DocumentSection {
  return typeof value === 'string' && SECTIONS.has(value);
}

/** The section of a `document_type`: non-strings and unknown types are Documents. */
export function documentSection(documentType: unknown): DocumentSection {
  if (typeof documentType !== 'string' || !Object.hasOwn(SECTION_OF_TYPE, documentType)) return 'documents';
  return SECTION_OF_TYPE[documentType] ?? 'documents';
}

/** A row with no `document_type` string: the legacy sort key's prefix (`PRD#d1` → `prd`). */
function typeOf(document: Record<string, unknown>): unknown {
  if (typeof document.document_type === 'string') return document.document_type;
  const sortKey = typeof document.sk === 'string' ? document.sk : '';
  const separator = sortKey.indexOf('#');
  return separator === -1 ? undefined : sortKey.slice(0, separator).toLowerCase();
}

/** The row's own `section` when it names one, else the table's answer. */
export function sectionOfDocument(document: Record<string, unknown>): DocumentSection {
  return isSection(document.section) ? document.section : documentSection(typeOf(document));
}

export interface SectionGroup<T> {
  section: DocumentSection;
  documents: T[];
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The row's last edit: `updated_at`, else `created_at` (what the project page's list sorts on). */
function lastEdit(document: Record<string, unknown>): string {
  return nonEmptyString(document.updated_at) || nonEmptyString(document.created_at);
}

/** Last edit first; ties by `document_id`, so the order is stable (the SPA's `byNewestEdit`). */
function byNewestEdit(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return lastEdit(b).localeCompare(lastEdit(a)) || nonEmptyString(a.document_id).localeCompare(nonEmptyString(b.document_id));
}

/**
 * All four sections in SECTION_ORDER (empty ones kept), each with its documents last edit first (`byNewestEdit`, the
 * project page's order). `shape` turns a raw row into what is listed; the section and the dates are read from the
 * raw row.
 */
export function groupBySection<T>(
  documents: readonly Record<string, unknown>[],
  shape: (document: Record<string, unknown>) => T,
): SectionGroup<T>[] {
  const rows = SECTION_ORDER.map((): Record<string, unknown>[] => []);
  for (const document of documents) {
    rows[SECTION_ORDER.indexOf(sectionOfDocument(document))]?.push(document);
  }
  return SECTION_ORDER.map((section, index): SectionGroup<T> => ({
    section,
    documents: [...(rows[index] ?? [])].sort(byNewestEdit).map(shape),
  }));
}
