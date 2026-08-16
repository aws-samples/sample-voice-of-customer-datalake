/**
 * @fileoverview Shared utilities for the prioritization feature.
 * @module pages/Prioritization/prioritizationUtils
 */

import type {
  Project, ProjectDocument, PrioritizationScore,
} from '../../api/types'

export interface PRFAQWithProject extends ProjectDocument {
  project_id: string
  project_name: string
  // Latest prototype (if any) for the same project. Surfaced under the PR/FAQ
  // preview row so reviewers can see the demo without leaving the page.
  prototype?: ProjectDocument
}

export type SortField = 'priority_score' | 'impact' | 'time_to_market' | 'created_at' | 'title'
export type SortDirection = 'asc' | 'desc'

export const DEFAULT_SCORE: PrioritizationScore = {
  document_id: '',
  impact: 0,
  time_to_market: 3,
  confidence: 0,
  strategic_fit: 0,
  notes: '',
}

/**
 * The composite score this page sorts by.
 *
 * These four weights are duplicated in `COMPOSITE_WEIGHTS` in the backend's
 * `projects_handler.py`, which uses them to report the SPREAD of the composite
 * score across reviewers. Re-weight here alone and that spread silently starts
 * describing a different unit than this column — so the pair is pinned by
 * `lambda/api/test/test_prioritization_weights_lockstep.py`, which fails rather
 * than letting the two drift.
 */
export const calculatePriorityScore = (score: PrioritizationScore): number => {
  return (score.impact * 0.4) + (score.time_to_market * 0.3) + (score.strategic_fit * 0.2) + (score.confidence * 0.1)
}

/**
 * The longest note a ballot may carry.
 *
 * Duplicated from `MAX_BALLOT_NOTE_LEN` in the backend's `projects_handler.py`,
 * which REFUSES a longer note rather than truncating it — the characters past the
 * bound are content, not a number that can be clamped. So the page has to know the
 * number too: `fetchApi` throws `API Error: 400` and discards the response body, so
 * a refusal the page cannot anticipate arrives as a Save button that appears to do
 * nothing.
 *
 * The pair is pinned by
 * `lambda/api/test/test_prioritization_note_bound_lockstep.py`, because a comment
 * saying the two agree cannot fail CI.
 */
export const MAX_NOTE_LENGTH = 2000

/**
 * The documents among the caller's pending edits whose note the API will refuse.
 *
 * Only pending edits are examined, because those are what a save sends: a
 * pre-ballot note that ran long stays readable on an untouched row and blocks
 * nothing.
 *
 * `maxLength` on the textarea stops a reviewer TYPING past the bound, but it does
 * not shorten a value that was already over it when the page loaded — the
 * pre-ballot map was written by a route with no bound at all — and touching any
 * slider on such a row sends the note along with it. So the bound has to be checked
 * before the request, not only prevented at the keyboard.
 *
 * Typed for the shape it READS — an optionally-absent note — rather than for
 * `PrioritizationScore`, which declares `notes` as a required string. A stored
 * ballot arrives from the network with no runtime guarantee it matches that
 * declaration, and a save is the wrong moment to discover otherwise: ballots
 * written before a partial save carried no note at all. `PrioritizationScore` is
 * still assignable to this, so the call site is unaffected, and the tolerance is in
 * the signature instead of behind a cast in a test.
 */
export function overLongNoteDocuments(
  edits: Record<string, { readonly notes?: string | null }>,
): string[] {
  return Object.entries(edits)
    .filter(([, score]) => noteLength(score.notes) > MAX_NOTE_LENGTH)
    .map(([documentId]) => documentId)
}

/**
 * The note's length in the unit the API measures it in.
 *
 * `.length` is UTF-16 CODE UNITS; Python's `len()` on the other side of the wire is
 * CODE POINTS. They differ for anything outside the basic plane — an emoji is two
 * units and one code point — so a plain `.length` blocks a note of 1500 emoji that
 * the API would have accepted, with a message quoting a limit the reviewer had not
 * reached. Spreading the string iterates by code point, which is what makes the two
 * sides bound the same thing rather than the same number.
 *
 * `maxLength` on the textarea cannot be corrected this way: the DOM attribute counts
 * code units, full stop. It is left as the tighter of the two on purpose — it only
 * limits TYPING and can therefore never produce a body the API refuses, which is the
 * invariant that matters. A reviewer pasting emoji past it is bounded early rather
 * than told a save failed.
 */
function noteLength(notes: string | null | undefined): number {
  return [...(notes ?? '')].length
}

export const getScoreColor = (score: number, max: number = 5): string => {
  const ratio = score / max
  if (ratio >= 0.8) return 'text-green-600 bg-green-50'
  if (ratio >= 0.6) return 'text-blue-600 bg-blue-50'
  if (ratio >= 0.4) return 'text-yellow-600 bg-yellow-50'
  return 'text-red-600 bg-red-50'
}

export const getPriorityLabel = (score: number, t: (key: string) => string): {
  label: string;
  color: string
} => {
  if (score >= 4) return {
    label: t('priority.high'),
    color: 'bg-green-100 text-green-800',
  }
  if (score >= 3) return {
    label: t('priority.medium'),
    color: 'bg-blue-100 text-blue-800',
  }
  if (score >= 2) return {
    label: t('priority.low'),
    color: 'bg-yellow-100 text-yellow-800',
  }
  return {
    label: t('priority.none'),
    color: 'bg-gray-100 text-gray-600',
  }
}

export function getScore(scores: Record<string, PrioritizationScore>, docId: string): PrioritizationScore {
  return scores[docId] ?? {
    ...DEFAULT_SCORE,
    document_id: docId,
  }
}

/**
 * Per-type display metadata for every scorable document type.
 *
 * This is the single source of truth for which document types are scorable.
 * Keys are constrained to `ProjectDocument['document_type']`, so a typo or
 * stale entry is a compile error. Adding a new scorable type here automatically
 * propagates to `isScorable`, to the `DocumentTypeBadge` in `PRFAQRow`, and to
 * the document select in `pages/FeedbackForms/ValidationLinkPicker`.
 *
 * `i18nKey` is namespace-QUALIFIED (`prioritization:…`) rather than relative,
 * for two reasons. It is read through a `t` bound to another namespace — the
 * validation-link picker's is `feedbackForms` — and a relative key would resolve
 * against that namespace and render the raw path. And a bare `'docType.prd'` is
 * invisible to `scripts/i18n-check.mjs`: keys held in data are only collected
 * when they carry a namespace (see `extractDataHeldKeys`), so without the prefix
 * these two are reported unused and become deletion candidates in a cleanup
 * pass, leaving the badge and the select rendering `docType.prd`.
 *
 * The prefix is in the TYPE, not only in the values: as a plain `string` field,
 * dropping it was a valid compile and only a test stood between that and raw key
 * paths in the UI. `tsc` now rejects it at the definition, and the resolution
 * gate in `prioritizationUtils.test.ts` remains the runtime check — vitest runs
 * through esbuild and does not typecheck, so the type alone would not have
 * failed a suite.
 */
export const SCORABLE_TYPE_META: Partial<Record<ProjectDocument['document_type'], {
  readonly badgeColor: string
  readonly i18nKey: `prioritization:${string}`
}>> = {
  prd: { badgeColor: 'bg-blue-100 text-blue-700', i18nKey: 'prioritization:docType.prd' },
  prfaq: { badgeColor: 'bg-purple-100 text-purple-700', i18nKey: 'prioritization:docType.prfaq' },
}

export function isScorable(doc: ProjectDocument): boolean {
  // `in` operator checks key presence in SCORABLE_TYPE_META at runtime;
  // the type of `doc.document_type` is already constrained by the API union,
  // so no type assertion is needed and any typo in SCORABLE_TYPE_META is a
  // compile error at the Partial<Record<...>> definition above.
  return doc.document_type in SCORABLE_TYPE_META
}

export function collectPRFAQs(allProjectDetails: Array<{ documents?: ProjectDocument[] }> | undefined, projects: Project[] | undefined): PRFAQWithProject[] {
  if (!allProjectDetails || !projects) return []

  const result: PRFAQWithProject[] = []
  for (const [index, detail] of allProjectDetails.entries()) {
    if (!detail.documents) continue
    const project = projects[index]
    const scorableDocs = detail.documents.filter(isScorable)
    // Pick the most-recent prototype for this project — that's the one the
    // user just generated from the latest PRD/PR-FAQ.
    const prototypes = detail.documents
      .filter((doc: ProjectDocument) => doc.document_type === 'prototype')
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    const latestPrototype = prototypes[0]
    for (const doc of scorableDocs) {
      result.push({
        ...doc,
        project_id: project.project_id,
        project_name: project.name,
        prototype: latestPrototype,
      })
    }
  }
  return result
}

export function comparePRFAQs(a: PRFAQWithProject, b: PRFAQWithProject, scores: Record<string, PrioritizationScore>, sortField: SortField): number {
  const scoreA = getScore(scores, a.document_id)
  const scoreB = getScore(scores, b.document_id)

  switch (sortField) {
    case 'priority_score': return calculatePriorityScore(scoreA) - calculatePriorityScore(scoreB)
    case 'impact': return scoreA.impact - scoreB.impact
    case 'time_to_market': return scoreA.time_to_market - scoreB.time_to_market
    case 'created_at': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    case 'title': return a.title.localeCompare(b.title)
  }
}
