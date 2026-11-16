/**
 * @fileoverview The no-clobber half of a document edit, on the client.
 *
 * `PUT /projects/{id}/documents/{document_id}` takes the revision the editor
 * loaded as `expected_revision` and answers 409 when someone saved in between
 * (shared/document_history.py). These pure helpers say which number that is,
 * which document "Load the latest" should reopen, which version a prototype's
 * Back to vN restores, and how the Documents list shows a PRD / PR/FAQ series (once).
 *
 * @module pages/ProjectDetail/documentEdit
 */
import { isVersionManagedDocument } from '../../api/documentLineage'
import { lastEdit } from '../../api/documentSections'
import { looksLikeHtmlDocument } from '../../components/prototypeSpec'
import { projectKey } from '../../api/projectQueryKeys'
import type { ProjectDocument } from '../../api/types'
import { documentSeriesKey } from './generatedDocTitle'

/**
 * The query key of a document's versions list (`GET …/documents/{doc}/versions`): the History dialog's, and the
 * page's read of the series when the assistant proposes an edit of another version. Under the project's prefix, so
 * a save or a restore (which invalidate the project) refresh it too.
 */
export const documentVersionsKey = (projectId: string, documentId: string) =>
  [...projectKey(projectId), 'document-versions', documentId] as const

/**
 * The revision an editor opened on `document` loaded.
 *
 * A PRD / PR/FAQ: its series `version` (the server compares it with the series
 * head — editing an old version is stale too). Absent on a legacy row the
 * backfill has not reached: no check rather than a false 409.
 * Research / custom: its edit counter, unset = 1 (as the server reads it).
 */
export function documentRevision(document: ProjectDocument): number | undefined {
  if (isVersionManagedDocument(document)) return document.version
  return document.revision ?? 1
}

/** The series a PRD / PR/FAQ version belongs to (its base title, by type); '' when there is no title to name it. */
export function seriesKeyOf(document: ProjectDocument): string {
  return documentSeriesKey(document.base_title ?? document.title, document.document_type)
}

/** The series the Documents list shows once: a PRD's or a PR/FAQ's (their page has the versions: its picker). */
const LISTED_ONCE_TYPES: ReadonlySet<string> = new Set(['prd', 'prfaq'])

/** The list entry a PRD / PR/FAQ version is shown under (its type and series), or null: an entry of its own. */
function listedSeriesOf(document: ProjectDocument): string | null {
  if (!LISTED_ONCE_TYPES.has(document.document_type)) return null
  const series = seriesKeyOf(document)
  return series === '' ? null : `${document.document_type}:${series}`
}

/** `a` is a later version of its series than `b`: its number, then (a row with none yet) its last edit, its id. */
function isLaterVersion(a: ProjectDocument, b: ProjectDocument): boolean {
  const byVersion = (a.version ?? 0) - (b.version ?? 0)
  if (byVersion !== 0) return byVersion > 0
  return lastEdit(a).localeCompare(lastEdit(b)) > 0
    || (lastEdit(a) === lastEdit(b) && a.document_id > b.document_id)
}

/**
 * The documents as the Documents list shows them, in their order: a PRD / PR/FAQ series once, as its newest version
 * (the page opens on it, its older versions a choice of its toolbar's version picker), every other document as it is
 * (a prototype keeps one entry per version: its pane's Back to vN works on them). Nothing stored is merged: each
 * version stays its own row.
 */
export function seriesHeads(documents: readonly ProjectDocument[]): ProjectDocument[] {
  const heads = new Map<string, ProjectDocument>()
  for (const document of documents) {
    const series = listedSeriesOf(document)
    if (series === null) continue
    const head = heads.get(series)
    if (head === undefined || isLaterVersion(document, head)) heads.set(series, document)
  }
  return documents.filter((document) => {
    const series = listedSeriesOf(document)
    return series === null || heads.get(series) === document
  })
}

/** The id of the entry of `listed` (seriesHeads) that `selected` is shown under: its series' for a PRD / PR/FAQ. */
export function listedIdOf(selected: ProjectDocument, listed: readonly ProjectDocument[]): string {
  const series = listedSeriesOf(selected)
  if (series === null) return selected.document_id
  return listed.find((document) => listedSeriesOf(document) === series)?.document_id ?? selected.document_id
}

/**
 * The numbered versions of `document`'s series among `documents` (its type and series key), newest first.
 * `document` itself counts even before the list has it (a version just written and selected).
 */
export function numberedSeries(document: ProjectDocument, documents: readonly ProjectDocument[]): ProjectDocument[] {
  const key = seriesKeyOf(document)
  const listed = documents.some((d) => d.document_id === document.document_id)
  return [...documents, ...(listed ? [] : [document])]
    .filter((d) => d.document_type === document.document_type && seriesKeyOf(d) === key && d.version !== undefined)
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
}

/** The latest version of a PRD / PR/FAQ's series (the row the Documents list shows); null for any other document. */
export function listedHeadOf(document: ProjectDocument, documents: readonly ProjectDocument[]): ProjectDocument | null {
  return listedSeriesOf(document) === null ? null : (numberedSeries(document, documents)[0] ?? null)
}

/**
 * Which page a document opens on. Each save of a PRD / PR/FAQ is a new version with a new id, and it must not
 * remount the page (a half-written comment, the undo history, the rail's tab): its series names the page. Any
 * other document (or a series with no title to name it) is its own.
 */
export function documentPageKey(document: ProjectDocument): string {
  if (!isVersionManagedDocument(document)) return `doc:${document.document_id}`
  const series = seriesKeyOf(document)
  return series === '' ? `doc:${document.document_id}` : `series:${document.document_type}:${series}`
}

/**
 * What a prototype's Back to vN restores (docs/prototype-builder.md, part 2): on the newest version of its
 * series, the version before it (`back`); on an older version, that version itself (`restore`). Null with
 * one version, for a row that does not know its version number, and when the target has no HTML to restore.
 * A version's HTML is in S3 (`content` empty) or inline in `content`; an early JSON screen spec has none,
 * and the server refuses it by the same rule (`version_html` in shared/prototype_versions.py).
 */
export function backTarget(
  document: ProjectDocument, documents: readonly ProjectDocument[],
): { readonly target: ProjectDocument; readonly kind: 'back' | 'restore' } | null {
  if (document.version === undefined) return null
  const series = numberedSeries(document, documents)
  const head = series[0]
  if (head === undefined) return null
  const isHead = head.document_id === document.document_id
  const target = isHead ? series[1] : document
  if (target === undefined) return null
  const { content, prototype_format: format } = target
  if (content !== '' && format !== 'html' && !looksLikeHtmlDocument(content)) return null
  return { target, kind: isHead ? 'back' : 'restore' }
}

/**
 * The newest copy of `edited` among `documents`: the same row for research /
 * custom, the head of its series for a PRD / PR/FAQ (an edit there is a new row).
 * Undefined when it is gone (deleted meanwhile).
 */
export function latestDocument(documents: readonly ProjectDocument[], edited: ProjectDocument): ProjectDocument | undefined {
  if (!isVersionManagedDocument(edited)) return documents.find((d) => d.document_id === edited.document_id)
  const key = seriesKeyOf(edited)
  return documents
    .filter((d) => d.document_type === edited.document_type && seriesKeyOf(d) === key)
    .reduce<ProjectDocument | undefined>((head, d) => ((d.version ?? 0) > (head?.version ?? 0) ? d : head), undefined)
}
