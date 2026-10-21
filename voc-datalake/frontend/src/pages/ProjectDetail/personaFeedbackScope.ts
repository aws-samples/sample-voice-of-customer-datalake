/**
 * @fileoverview The feedback a persona generation draws from, read off the wizard's
 * context config.
 *
 * One mapping for both consumers: the generation mutation (useProjectData) and the
 * wizard's live preview count (PersonaFeedbackPreview). Two copies would let the
 * count describe a different set than the one generation then samples.
 *
 * @module pages/ProjectDetail/personaFeedbackScope
 */
import { filtersKey, toFeedbackQueryParams } from '../../api/feedbackFilters'
import type { PersonaPreviewBody } from '../../api/projectsApi'
import type { ContextConfig } from '../../components/DataSourceWizard/exports'

/** The request fields that scope a persona generation's feedback. */
export function personaFeedbackScope(config: ContextConfig): PersonaPreviewBody {
  return {
    sources: config.sources,
    categories: config.categories,
    sentiments: config.sentiments,
    days: config.days,
    // The richer shared-model dimensions (subcategory / urgent / enrichment /
    // cf_*). The flat sources/categories/sentiments above drive the DynamoDB
    // query; these narrow it further via the backend post-pass.
    extraFilters: toFeedbackQueryParams(config.feedback),
  }
}

const sortedCopy = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b))

/** A stable string for that scope, for query keys: selection order is ignored. */
export function personaFeedbackScopeKey(config: ContextConfig): string {
  return JSON.stringify({
    sources: sortedCopy(config.sources),
    categories: sortedCopy(config.categories),
    sentiments: sortedCopy(config.sentiments),
    days: config.days,
    feedback: filtersKey(config.feedback),
  })
}
