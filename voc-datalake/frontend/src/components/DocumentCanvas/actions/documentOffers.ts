/**
 * @fileoverview What the page's bar offers whichever door opens it (the Document menu, the toolbar): Share, the review
 * link of a PR/FAQ or PRD, for an editor of the project; History on every document edited on its canvas (a decision's
 * versions are its record's).
 *
 * @module components/DocumentCanvas/actions/documentOffers
 */
import { isEditedElsewhere } from './documentKinds'
import type { DocumentShareControls } from './DocumentMenu'
import type { ProjectDocument } from '../../../api/types'

/** Share's controls when it is offered, else null (a viewer; a document without a review link). */
export function shareOffered(canEdit: boolean, share: DocumentShareControls | null): DocumentShareControls | null {
  return canEdit ? share : null
}

/** Whether History (and the version picker) is offered. */
export function historyOffered(document: ProjectDocument): boolean {
  return !isEditedElsewhere(document.document_type)
}
