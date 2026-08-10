/**
 * @fileoverview Editor control for the project/document a feedback form validates.
 *
 * The link is optional, and staying optional is the point: a form that validates
 * nothing keeps both fields at '' and behaves exactly as it did before this
 * control existed. Every select therefore has a "not linked" option, and
 * clearing the project clears the document with it.
 *
 * Extracted into its own module rather than added inline to `FeedbackForms.tsx`:
 * that file is already at the repo's `max-lines` ceiling and `FormEditor` at its
 * complexity ceiling.
 *
 * @module pages/FeedbackForms/ValidationLinkPicker
 */

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import type { Project, ProjectDocument } from '../../api/types'
import type { ReactElement } from 'react'

/** The link, as the editor holds it. '' on either field means "not set". */
export interface ValidationLink {
  readonly project_id: string
  readonly document_id: string
}

/**
 * Document types worth validating with a feedback form: the same two the
 * Prioritization page scores. Anything else (research notes, prototypes) is not
 * a proposal a reviewer scores, so linking a form to it would show ratings on no
 * row at all.
 */
const LINKABLE_DOCUMENT_TYPES: ReadonlySet<ProjectDocument['document_type']> = new Set(['prd', 'prfaq'])

export default function ValidationLinkPicker({
  value, onChange, enabled,
}: {
  readonly value: ValidationLink
  readonly onChange: (link: ValidationLink) => void
  /** False before the API endpoint is configured — skips the projects fetch. */
  readonly enabled: boolean
}): ReactElement {
  const { t } = useTranslation('feedbackForms')

  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsApi.getProjects(),
    enabled,
  })
  const projects: Project[] = projectsData?.projects ?? []

  // Only the selected project's documents are fetched — the picker never needs
  // the whole corpus, and the query is skipped entirely while unlinked.
  const { data: projectDetail } = useQuery({
    queryKey: ['project', value.project_id],
    queryFn: () => projectsApi.getProject(value.project_id),
    enabled: enabled && value.project_id !== '',
  })
  const documents = (projectDetail?.documents ?? []).filter(
    (doc) => LINKABLE_DOCUMENT_TYPES.has(doc.document_type),
  )

  // A stored document_id whose document no longer exists (regenerated, or from
  // another project) must not silently vanish from the control: showing '' would
  // make Save write a cleared link the admin never asked for.
  const hasStoredDocument = value.document_id !== ''
    && !documents.some((doc) => doc.document_id === value.document_id)

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
        <h4 className="font-medium text-blue-900 mb-2 text-sm sm:text-base">{t('editor.validationTitle')}</h4>
        <p className="text-xs sm:text-sm text-blue-800">{t('editor.validationDescription')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="validation-project">
            {t('editor.validationProjectLabel')}
          </label>
          <select
            id="validation-project"
            value={value.project_id}
            // Clearing or switching the project clears the document: a document
            // id only means anything inside its own project.
            onChange={(e) => onChange({ project_id: e.target.value, document_id: '' })}
            className="input"
          >
            <option value="">{t('editor.validationNoProject')}</option>
            {projects.map((project) => (
              <option key={project.project_id} value={project.project_id}>{project.name}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">{t('editor.validationProjectHint')}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="validation-document">
            {t('editor.validationDocumentLabel')}
          </label>
          <select
            id="validation-document"
            value={value.document_id}
            onChange={(e) => onChange({ project_id: value.project_id, document_id: e.target.value })}
            className="input"
            disabled={value.project_id === ''}
          >
            <option value="">{t('editor.validationWholeProject')}</option>
            {hasStoredDocument ? (
              <option value={value.document_id}>{t('editor.validationUnknownDocument')}</option>
            ) : null}
            {documents.map((doc) => (
              <option key={doc.document_id} value={doc.document_id}>{doc.title}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">{t('editor.validationDocumentHint')}</p>
        </div>
      </div>
    </div>
  )
}
