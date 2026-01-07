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
