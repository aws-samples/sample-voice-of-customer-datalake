/**
 * @fileoverview The no-clobber half of a document edit, on the client.
 *
 * `PUT /projects/{id}/documents/{document_id}` takes the revision the editor
 * loaded as `expected_revision` and answers 409 when someone saved in between
 * (shared/document_history.py). These pure helpers say which number that is,
 * which document "Load the latest" should reopen, and which version a prototype's
 * Back to vN restores.
 *
 * @module pages/ProjectDetail/documentEdit
 */
import { isVersionManagedDocument } from '../../api/documentLineage'
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
