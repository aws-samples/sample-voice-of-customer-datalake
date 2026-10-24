/**
 * Context configuration types and defaults for DataSourceWizard
 */

export interface ContextConfig {
  // Data source toggles
  useFeedback: boolean
  usePersonas: boolean
  useDocuments: boolean
  useResearch: boolean
  // Feedback filters
  sources: string[]
  categories: string[]
  sentiments: string[]
  days: number
  // Selected items
  selectedPersonaIds: string[]
  selectedDocumentIds: string[]
  selectedResearchIds: string[]
}

/**
 * One category chip in the feedback-filters step. `value` is the category NAME
 * (what a review stores and the backend filters on), never the config `id`;
 * `label` is the display text.
 */
export interface CategoryOption {
  readonly value: string
  readonly label: string
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
  selectedPersonaIds: [],
  selectedDocumentIds: [],
  selectedResearchIds: [],
}
