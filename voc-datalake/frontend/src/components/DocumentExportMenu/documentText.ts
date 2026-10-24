/**
 * @fileoverview The text body of a project document, for every export format.
 * @module components/DocumentExportMenu/documentText
 */
import type { ProjectDocument } from '../../api/types'

/**
 * `doc.content`, or '' when it is not a string. The project-detail schema
 * already defaults it, but S3-backed artifacts omit inline content on the wire
 * and an export must never print "undefined", so the read stays guarded here
 * instead of trusting every caller to have normalized.
 */
export function documentText(doc: Pick<ProjectDocument, 'content'>): string {
  return typeof doc.content === 'string' ? doc.content : ''
}
