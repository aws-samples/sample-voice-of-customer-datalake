/**
 * @fileoverview In-app micro-feedback under a document the app generated (7.66.00, docs/micro-feedback.md): research,
 * a PR/FAQ or a PRD, asked once per document. Not under one a person wrote by hand (`origin: 'human'`), a merge of
 * others, a prototype (DocumentsTab asks about those itself) or any other type.
 *
 * @module components/MicroFeedback/DocumentMicroFeedback
 */
import MicroFeedback from './MicroFeedback'
import type { AppFeedbackAction } from '../../api/appFeedbackApi'
import type { ProjectDocument } from '../../api/types'

const DOCUMENT_ACTIONS: Readonly<Record<string, AppFeedbackAction>> = { research: 'research', prfaq: 'prfaq', prd: 'prd' }

type Generated = Pick<ProjectDocument, 'document_id' | 'document_type' | 'origin' | 'source_documents'>

/** The action a generated document asks about, or null. */
function documentFeedbackAction(document: Generated): AppFeedbackAction | null {
  if (document.origin === 'human' || (document.source_documents?.length ?? 0) > 0) return null
  return DOCUMENT_ACTIONS[document.document_type] ?? null
}

export default function DocumentMicroFeedback({ document }: Readonly<{ document: Generated }>) {
  const action = documentFeedbackAction(document)
  return action === null ? null : <MicroFeedback action={action} instance={document.document_id} />
}
