/**
 * @fileoverview Which documents the page edits on its canvas, and which are renamed by their writers. A prototype
 * never reaches the page (its preview pane revises it); a decision is edited in its own tab, so on the page it reads
 * as a viewer would, with no canvas editing and no content versions of its own.
 *
 * @module components/DocumentCanvas/actions/documentKinds
 */
import { isVersionManagedDocument } from '../../../api/documentLineage'

/** A document of this type is edited outside the canvas: no Save, no History on its page. */
export function isEditedElsewhere(documentType: string): boolean {
  return documentType === 'decision'
}

/**
 * A document of this kind is renamed by its writers (a research or custom document, a product report): on its page's
 * title (Document → Rename) and from its card in the list. A PRD's, PR/FAQ's or prototype's title is its series' own,
 * kept canonical by the server; a decision is edited in its own tab.
 */
export function isRenamedInPlace(document: { readonly document_type: string }): boolean {
  return !isEditedElsewhere(document.document_type) && !isVersionManagedDocument(document)
}
