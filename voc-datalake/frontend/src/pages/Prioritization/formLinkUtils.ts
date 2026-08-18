/**
 * @fileoverview Matching a scorable document's row to the feedback forms that
 * validate it.
 *
 * The link lives on the form (`project_id`, `document_id` — both optional), not
 * on the document, so matching is a read-side concern.
 *
 * `project_id` is matched first and `document_id` is treated as a refinement,
 * deliberately: regenerating a PRD or PR/FAQ mints a new `document_id`, so a
 * link stored against the old id would silently detach and the evidence
 * collected about that proposal would vanish from the page. Matching on the
 * project keeps it visible.
 *
 * A form pinned to a document that still exists is NOT shown on that document's
 * siblings, though — otherwise a PR/FAQ's ratings would also appear on the PRD
 * row of the same project. The project-level fallback applies only to forms
 * whose stored `document_id` is empty (a deliberate project-wide link) or no
 * longer names a live document (the regenerated case).
 *
 * @module pages/Prioritization/formLinkUtils
 */

import { z } from 'zod'
import type {
  Project, ProjectDetail,
} from '../../api/types'

/** One document of one project — what a form's link is matched against. */
export interface DocumentRowIdentity {
  readonly project_id: string
  readonly document_id: string
}

/**
 * A prioritization row, as far as form matching is concerned: its project and the
 * documents it holds.
 *
 * Structurally a subset of `PrioritizationRowView`, declared here rather than
 * imported so this module stays independent of the page's own view type — the same
 * reason `DetailWithDocuments` is a `Pick` rather than the whole `ProjectDetail`.
 */
export interface RowIdentity {
  readonly project_id: string
  readonly documents: readonly { readonly document_id: string }[]
}

/**
 * The three fields this page reads off a feedback form, validated at the query
 * boundary the same way `pages/FeedbackForms/formSchema.ts` validates the full
 * record.
 *
 * A narrow schema rather than a reuse of `FeedbackFormSchema`, for two reasons:
 * this page needs identity plus the link and nothing else, and importing the
 * full schema would pull `formTemplates` (and its icon imports) into the
 * prioritization chunk for defaults it never renders.
 *
 * Lenient in the same spirit: every field degrades to '' rather than rejecting
 * the record, because stored forms predate the link fields and a form that
 * fails to normalize should read as "not linked", never crash the page. A form
 * without a usable `form_id` IS dropped — it feeds the `['form-stats', form_id]`
 * query key, so an invented identity would collide across records.
 */
const LinkedFormSchema = z.looseObject({
  form_id: z.string().min(1),
  name: z.string().catch(''),
  project_id: z.string().catch(''),
  document_id: z.string().catch(''),
})

/** The shape `selectLinkedForms` needs — structurally a subset of FeedbackForm. */
export type LinkedForm = z.infer<typeof LinkedFormSchema>

/**
 * Normalize the wire's form list down to the link fields, dropping records
 * without a usable identity.
 */
export function normalizeLinkedForms(rawForms: readonly unknown[]): LinkedForm[] {
  return rawForms.flatMap((raw) => {
    const parsed = LinkedFormSchema.safeParse(raw)
    return parsed.success ? [parsed.data] : []
  })
}

/** The subset of a project detail response this module reads. */
type DetailWithDocuments = Pick<Partial<ProjectDetail>, 'documents'>

/**
 * Live document ids per project, keyed by `project_id`.
 *
 * Needed to tell a project-wide link apart from a stale one: a form pointing at
 * a document that is still present belongs to that document alone, while a form
 * pointing at a document that is gone (regenerated) falls back to the project.
 * Details are aligned with `projects` by index, the same way `collectPRFAQs`
 * aligns them.
 */
export function collectProjectDocumentIds(
  allProjectDetails: readonly (DetailWithDocuments | undefined)[] | undefined,
  projects: readonly Project[] | undefined,
): Map<string, Set<string>> {
  const byProject = new Map<string, Set<string>>()
  if (!allProjectDetails || !projects) return byProject
  for (const [index, detail] of allProjectDetails.entries()) {
    const project = projects[index]
    if (!project) continue
    // A detail can be absent even when the array is not: a caller mapping
    // `useQueries().map((q) => q.data)` yields undefined for every entry still
    // loading, and dereferencing that would throw mid-load.
    if (!detail) continue
    byProject.set(project.project_id, new Set((detail.documents ?? []).map((doc) => doc.document_id)))
  }
  return byProject
}

/**
 * The feedback forms whose collected ratings are evidence about this row.
 *
 * Returns every exact `document_id` match when there is one — several forms can
 * validate the same document — and otherwise the project's forms that are not
 * pinned to some other live document. A form with no `project_id` never matches
 * any row, which is what keeps standalone website surveys off this page.
 *
 * @param liveDocumentIds document ids currently present in the row's project;
 *   `undefined` while the project detail is still loading, in which case no
 *   link is treated as stale.
 */
export function selectLinkedForms(
  forms: readonly LinkedForm[],
  row: DocumentRowIdentity,
  liveDocumentIds?: ReadonlySet<string>,
): LinkedForm[] {
  if (row.project_id === '') return []
  const projectForms = forms.filter((form) => form.project_id === row.project_id)

  const exact = projectForms.filter((form) => form.document_id === row.document_id)
  if (exact.length > 0) return exact

  return projectForms.filter((form) => {
    const linkedDocumentId = form.document_id
    // Project-wide link, or a link to a document that no longer exists
    // (regenerated): both are evidence about this project's proposal.
    return linkedDocumentId === '' || !(liveDocumentIds?.has(linkedDocumentId) ?? false)
  })
}

/**
 * The linked forms for every DOCUMENT of every row, keyed by `document_id`.
 *
 * Keyed by document even though a row is now a project's SET of documents, and
 * deliberately: a form validates one document, the evidence it collected is about
 * that document, and the expanded row shows each of its documents separately. So
 * the linkage stays where it belongs and the row is merely how a reader reaches it
 * — which is why this takes the rows and iterates their documents rather than
 * collapsing a row's evidence into one bucket. A PR/FAQ's ratings appearing under
 * its project's PRD is the confusion this whole module's matching rules exist to
 * avoid.
 *
 * Resolved for the whole list up front because it is pure bookkeeping over data
 * already in hand — no request is made here. The expensive per-form stats read
 * stays behind row expansion (see `LinkedFormEvidence`).
 */
export function buildLinkedFormsByDocument(
  forms: readonly LinkedForm[],
  rows: readonly RowIdentity[],
  documentIdsByProject: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, LinkedForm[]> {
  const byDocument = new Map<string, LinkedForm[]>()
  for (const row of rows) {
    for (const { document_id: documentId } of row.documents) {
      // Keyed by document_id alone: document ids are server-minted and globally
      // unique, and one document can only belong to one project — so a row's
      // project plus the document is all the matching needs, and no read site has
      // to unpack a composite key.
      byDocument.set(
        documentId,
        selectLinkedForms(forms, {
          project_id: row.project_id,
          document_id: documentId,
        }, documentIdsByProject.get(row.project_id)),
      )
    }
  }
  return byDocument
}
