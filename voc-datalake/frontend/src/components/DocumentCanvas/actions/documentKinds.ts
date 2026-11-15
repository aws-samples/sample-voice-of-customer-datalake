/**
 * @fileoverview Which documents the page edits on its canvas. A prototype never reaches the page (its preview pane
 * revises it); a decision is edited in its own tab, so on the page it reads as a viewer would, with no canvas
 * editing and no content versions of its own.
 *
 * @module components/DocumentCanvas/actions/documentKinds
 */

/** A document of this type is edited outside the canvas: no Save, no History on its page. */
export function isEditedElsewhere(documentType: string): boolean {
  return documentType === 'decision'
}
