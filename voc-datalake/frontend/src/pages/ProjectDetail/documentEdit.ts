/**
 * @fileoverview The no-clobber half of a document edit, on the client.
 *
 * `PUT /projects/{id}/documents/{document_id}` takes the revision the editor
 * loaded as `expected_revision` and answers 409 when someone saved in between
 * (shared/document_history.py). These two pure helpers say which number that is,
 * and which document "Load the latest" should reopen.
 *
 * @module pages/ProjectDetail/documentEdit
 */
import { isVersionManagedDocument } from '../../api/documentLineage'
import type { ProjectDocument } from '../../api/types'
import { documentSeriesKey } from './generatedDocTitle'

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

function seriesKeyOf(document: ProjectDocument): string {
  return documentSeriesKey(document.base_title ?? document.title, document.document_type)
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
