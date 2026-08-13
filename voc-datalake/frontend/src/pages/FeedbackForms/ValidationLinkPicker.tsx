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
import { projectKey, projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import { isScorable, SCORABLE_TYPE_META } from '../Prioritization/prioritizationUtils'
import type { Project, ProjectDocument } from '../../api/types'
import type { ReactElement } from 'react'

/** The link, as the editor holds it. '' on either field means "not set". */
export interface ValidationLink {
  readonly project_id: string
  readonly document_id: string
}

/**
 * Whether a select needs an extra option to hold an id that its fetched list
 * does not offer, and how to label it.
 *
 * Every state here exists to avoid printing something untrue next to a link the
 * admin is about to Save. The stored id stays the select's value in all of them
 * — Save has to round-trip it either way — only the label differs.
 *
 * - `null`  — nothing stored, or the stored id is in the list: no extra option.
 * - `'pending'` — stored, absent from the list, and the list is still on its
 *   way. On the first render of EVERY intact link the list is empty, so
 *   labelling that "no longer available" tells the admin their link is gone
 *   when it is fine.
 * - `'unverified'` — the list will never arrive: the request was rejected, or
 *   there is no API endpoint configured so it was never made. "Loading" is
 *   false (nothing is loading) and "no longer available" is false too (nobody
 *   managed to look), so the label says only that it could not be checked.
 * - `'missing'` — the list resolved and genuinely does not contain the id (a
 *   regenerated document, a deleted project). Only then is the alarming label
 *   the truth.
 */
type StoredOptionState = 'pending' | 'unverified' | 'missing' | null

function storedOptionState(
  storedId: string,
  availableIds: readonly string[],
  list: { readonly resolved: boolean; readonly canResolve: boolean },
): StoredOptionState {
  if (storedId === '') return null
  if (availableIds.includes(storedId)) return null
  if (list.resolved) return 'missing'
  return list.canResolve ? 'pending' : 'unverified'
}

/**
 * The label for one non-null state.
 *
 * A helper taking `t` rather than nested ternaries in the JSX (three states in
 * two selects is four branches of markup, and this editor is already at the
 * repo's complexity ceiling) — and rather than a key lookup table, so that every
 * key stays a literal argument to `t()`. `scripts/i18n-check.mjs` only sees keys
 * written that way or as an `xKey: 'ns:key'` data property; a key held in a plain
 * map is reported unreferenced and is then a candidate for deletion in a cleanup
 * pass, which would leave this select rendering a raw key path.
 *
 * Shaped as one function because `pending` is deliberately the same sentence for
 * both selects; only the other two name which thing is linked.
 */
function storedOptionLabel(
  state: Exclude<StoredOptionState, null>,
  select: 'project' | 'document',
  t: (key: string) => string,
): string {
  if (state === 'pending') return t('editor.validationLoadingLink')
  if (select === 'project') {
    return state === 'missing'
      ? t('editor.validationUnknownProject')
      : t('editor.validationUnverifiedProject')
  }
  return state === 'missing'
    ? t('editor.validationUnknownDocument')
    : t('editor.validationUnverifiedDocument')
}

/**
 * One document's option text: its title, plus the type it is.
 *
 * The type is here because the title alone does not identify the document. A
 * project's PRD and its PR/FAQ are generated from the same feature idea and
 * routinely carry the same or near-identical titles, so a list of names asks the
 * admin to link a form to a proposal they cannot tell apart — and the two are
 * separate rows on the Prioritization page, where the ratings then show up.
 *
 * `(TYPE)` after the name rather than before it, following `CheckboxItem` in
 * `pages/ProjectDetail/PickerComponents` — the repo's other picker that shows a
 * document's type inline — so the two read the same way.
 *
 * The label comes from `SCORABLE_TYPE_META`, the same source as the badge on the
 * Prioritization row this link feeds, so the type is named identically in both
 * places. The raw `document_type` is the fallback: a type made scorable without
 * display metadata then reads as its own slug rather than as empty parentheses.
 * Unreachable today — the list is filtered by `isScorable`, which reads the very
 * table the label comes from — and kept because that coupling is not enforced.
 */
function documentOptionLabel(doc: ProjectDocument, t: (key: string) => string): string {
  const typeMeta = SCORABLE_TYPE_META[doc.document_type]
  const typeLabel = typeMeta ? t(typeMeta.i18nKey) : doc.document_type
  // `title` is declared `string` and `projectsApi` has no schema at its boundary,
  // so nothing enforces that. It matters here and not before this change: `{title}`
  // rendered an empty option for a missing title, while interpolating it prints the
  // literal "undefined". Falling back to the id, the way DocumentsTab labels a
  // revision with no title — an opaque id at least identifies the record.
  const name = typeof doc.title === 'string' && doc.title.trim() !== '' ? doc.title : doc.document_id
  return `${name} (${typeLabel})`
}

export default function ValidationLinkPicker({
  value, onChange, enabled,
}: {
  readonly value: ValidationLink
  readonly onChange: (link: ValidationLink) => void
  /** False before the API endpoint is configured — skips the projects fetch. */
  readonly enabled: boolean
}): ReactElement {
  const { t } = useTranslation('feedbackForms')

  // Shared keys, not literals: `['projects']` and `['project', id]` are both
  // read by other features (Projects, Prioritization, the project page and
  // Breadcrumbs). Spelling them here would silently address a separate cache
  // entry the day either is renamed — the picker would keep working and just
  // re-fetch, and miss the invalidations Projects.tsx fires on mutate.
  const {
    data: projectsData, isSuccess: projectsResolved, isError: projectsFailed,
  } = useQuery({
    queryKey: projectsKey(),
    queryFn: () => projectsApi.getProjects(),
    enabled,
  })
  const projects: Project[] = projectsData?.projects ?? []

  // Only the selected project's documents are fetched — the picker never needs
  // the whole corpus, and the query is skipped entirely while unlinked.
  // Held in a const because `storedOptionState` below needs the SAME condition:
  // if this query cannot run, its list can never resolve, and calling that
  // "still loading" is the very thing this control stopped doing. A record with
  // a document_id but no project_id is reachable (`PUT {"document_id": ...}`
  // validates each field independently), and it disables this query.
  const detailEnabled = enabled && value.project_id !== ''
  const {
    data: projectDetail, isSuccess: detailResolved, isError: detailFailed,
  } = useQuery({
    queryKey: projectKey(value.project_id),
    queryFn: () => projectsApi.getProject(value.project_id),
    enabled: detailEnabled,
  })
  // `isScorable` rather than a local set of types: it reads SCORABLE_TYPE_META,
  // which documents itself as the single source of truth for which document
  // types the Prioritization page scores. A form can only show its ratings on a
  // row that exists, so "linkable here" and "scorable there" are the same
  // question and must not be answerable twice.
  const documents = (projectDetail?.documents ?? []).filter(isScorable)

  // A stored id whose record no longer exists (a regenerated document, a
  // deleted project) must not silently vanish from the control: showing ''
  // would make Save write a cleared link the admin never asked for. Both states
  // are gated on the corresponding query having RESOLVED, because until it does
  // the list is empty and every intact link looks missing.
  const storedDocument = storedOptionState(
    value.document_id, documents.map((doc) => doc.document_id),
    { resolved: detailResolved, canResolve: detailEnabled && !detailFailed },
  )
  const storedProject = storedOptionState(
    value.project_id, projects.map((project) => project.project_id),
    { resolved: projectsResolved, canResolve: enabled && !projectsFailed },
  )

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
            {storedProject === null ? null : (
              <option value={value.project_id}>
                {storedOptionLabel(storedProject, 'project', t)}
              </option>
            )}
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
            {storedDocument === null ? null : (
              <option value={value.document_id}>
                {storedOptionLabel(storedDocument, 'document', t)}
              </option>
            )}
            {documents.map((doc) => (
              <option key={doc.document_id} value={doc.document_id}>
                {documentOptionLabel(doc, t)}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">{t('editor.validationDocumentHint')}</p>
        </div>
      </div>
    </div>
  )
}
