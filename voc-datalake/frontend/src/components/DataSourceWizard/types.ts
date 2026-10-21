/**
 * Context configuration types and defaults for DataSourceWizard
 */
import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'

export interface ContextConfig {
  // Data source toggles
  useFeedback: boolean
  usePersonas: boolean
  useDocuments: boolean
  useResearch: boolean
  // Feedback filters — the three the wizard has always had plus the time window.
  // These stay as flat lists because the DynamoDB query pushes them down and
  // several non-filter consumers (ContextSummary, the doc/merge mutations) read
  // them directly.
  sources: string[]
  categories: string[]
  sentiments: string[]
  days: number
  // The richer shared-model dimensions the wizard did NOT used to offer
  // (subcategory, urgent-only, enrichment fields, custom cf_* fields). Carried
  // as the shared FeedbackFilterState and sent via toFeedbackQueryParams, so
  // the backend scopes personas/research the same way the pages do. `sources`,
  // `categories` and `sentiments` are intentionally NOT duplicated in here —
  // the flat fields above remain their source of truth.
  feedback: FeedbackFilterState
  // Selected items
  selectedPersonaIds: string[]
  selectedDocumentIds: string[]
  selectedResearchIds: string[]
}

export const defaultContextConfig: ContextConfig = {
  useFeedback: true,
  usePersonas: false,
  useDocuments: false,
  useResearch: false,
  sources: [],
  categories: [],
  sentiments: [],
  days: 30,
  feedback: EMPTY_FEEDBACK_FILTERS,
  selectedPersonaIds: [],
  selectedDocumentIds: [],
  selectedResearchIds: [],
}
