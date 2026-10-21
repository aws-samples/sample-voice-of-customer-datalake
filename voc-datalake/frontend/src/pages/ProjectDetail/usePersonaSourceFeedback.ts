/**
 * @fileoverview Paged reads of the feedback a persona was generated from.
 *
 * @module pages/ProjectDetail/usePersonaSourceFeedback
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { projectsApi } from '../../api/projectsApi'
import type {
  PersonaFeedbackScope, PersonaSourceFeedbackItem, PersonaSourceFeedbackPage,
} from '../../api/personaFeedbackSchema'
import type { PersonaFeedbackProvenance } from '../../api/types'

/** Rows per request. The route allows up to 50; each row is one feedback lookup. */
export const PERSONA_FEEDBACK_PAGE_SIZE = 25

export const personaSourceFeedbackKey = (projectId: string, personaId: string, scope: PersonaFeedbackScope) =>
  ['persona-source-feedback', projectId, personaId, scope] as const

/**
 * The next page's offset, from the offset REQUESTED rather than the rows returned:
 * a page is short when some of its feedback was deleted, and stepping by the rows
 * returned would re-read ids already shown.
 */
export function nextPersonaFeedbackOffset(page: PersonaSourceFeedbackPage, requestedOffset: number): number | undefined {
  if (!page.available) return undefined
  const next = requestedOffset + PERSONA_FEEDBACK_PAGE_SIZE
  return next < page.total ? next : undefined
}

/** Everything the loaded pages say, combined. */
export interface PersonaSourceFeedbackSummary {
  /** False when the persona predates source tracking. */
  readonly available: boolean
  readonly total: number
  readonly items: readonly PersonaSourceFeedbackItem[]
  /** Deleted-since-generation ids across every loaded page. */
  readonly missing: number
  readonly provenance: PersonaFeedbackProvenance | null
}

export function summarizePersonaFeedbackPages(pages: readonly PersonaSourceFeedbackPage[]): PersonaSourceFeedbackSummary {
  const first = pages[0]
  return {
    available: first?.available ?? false,
    total: first?.total ?? 0,
    items: pages.flatMap((page) => page.items),
    missing: pages.reduce((sum, page) => sum + page.missing, 0),
    provenance: first?.provenance ?? null,
  }
}

export function usePersonaSourceFeedback(projectId: string, personaId: string, scope: PersonaFeedbackScope) {
  return useInfiniteQuery({
    queryKey: personaSourceFeedbackKey(projectId, personaId, scope),
    queryFn: ({ pageParam }) => projectsApi.getPersonaSourceFeedback(projectId, personaId, {
      scope,
      offset: pageParam,
      limit: PERSONA_FEEDBACK_PAGE_SIZE,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => nextPersonaFeedbackOffset(lastPage, lastPageParam),
  })
}
