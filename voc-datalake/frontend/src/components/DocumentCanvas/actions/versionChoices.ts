/**
 * @fileoverview What the History list (`GET …/documents/{doc}/versions`, newest first) says about the page's document:
 * which version is the page's own, which is the latest, and what choosing one in the toolbar's version picker means.
 *
 * @module components/DocumentCanvas/actions/versionChoices
 */
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'

/** What a chosen version is to the page: its own (back to it), the latest of a series the page shows an older row of
 * (the page moves to it), or an older version (shown read-only, `/v/<n>`). */
export type VersionChoice =
  | { readonly kind: 'own' }
  | { readonly kind: 'latest'; readonly documentId: string }
  | { readonly kind: 'older'; readonly number: number }

/** The page's own version among `versions`: a series version is its row's id, a revision the current one. */
export function ownVersion(versions: readonly DocumentVersion[], document: ProjectDocument): DocumentVersion | undefined {
  return versions.find((version) => version.version_id === document.document_id) ?? versions.find((version) => version.current)
}

/** The latest version's number (the list's `current`, else the highest), or null for an empty list. */
export function latestNumber(versions: readonly DocumentVersion[]): number | null {
  const current = versions.find((version) => version.current)?.version
  if (current !== undefined) return current
  return versions.length === 0 ? null : Math.max(...versions.map((version) => version.version))
}

/** What choosing `version` means on a page showing `document`. */
export function choiceOf(version: DocumentVersion, versions: readonly DocumentVersion[], document: ProjectDocument): VersionChoice {
  if (version.version_id === ownVersion(versions, document)?.version_id) return { kind: 'own' }
  if (version.current && version.document_id !== undefined && version.document_id !== document.document_id) {
    return { kind: 'latest', documentId: version.document_id }
  }
  return { kind: 'older', number: version.version }
}
