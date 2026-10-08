/**
 * @fileoverview Fixtures shared by the DataSourceWizard specs: the sample
 * personas and documents every step renders, the accent colour set the
 * filters step is styled with, and the `api/client` mock shape the wizard
 * reads sources and categories through.
 */
import { vi } from 'vitest'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import { defaultContextConfig, type ContextConfig } from './types'

/** Two personas: enough to show a count and a multi-select. */
export const wizardPersonas: ProjectPersona[] = [
  { persona_id: 'p1', name: 'Power User', tagline: 'Uses all features', created_at: '' },
  { persona_id: 'p2', name: 'Casual User', tagline: 'Basic usage', created_at: '' },
]

/** One PRD plus one research document, so both document pickers have a row. */
export const wizardDocuments: ProjectDocument[] = [
  { document_id: 'd1', title: 'Product PRD', document_type: 'prd', content: '', created_at: '' },
  { document_id: 'd2', title: 'Research Report', document_type: 'research', content: '', created_at: '' },
]

/** The `colors` prop of FeedbackFiltersStep for the brand accent. */
export const accentColors = {
  bg: 'bg-accent',
  fg: 'text-accent-fg',
  bgLight: 'bg-accent-subtle',
  border: 'border-accent/30',
  text: 'text-accent-text',
  hover: 'hover:bg-accent-hover',
}

/** `defaultContextConfig` with `overrides` applied. */
export function contextConfig(overrides: Partial<ContextConfig> = {}): ContextConfig {
  return { ...defaultContextConfig, ...overrides }
}

/** Split `documents` the way the wizard does for ItemSelectionStep. */
export function splitDocuments(documents: ProjectDocument[]) {
  return {
    otherDocs: documents.filter(d => d.document_type !== 'research'),
    researchDocs: documents.filter(d => d.document_type === 'research'),
  }
}

/** The two `api.*` reads the wizard performs, as mocks a spec can programme. */
export const wizardApiMocks = {
  getSources: vi.fn<(days: number) => Promise<unknown>>(),
  getCategoriesConfig: vi.fn<() => Promise<unknown>>(),
}

/**
 * The factory for `vi.mock('../../api/client', wizardApiClientMock)`.
 *
 * `vi.mock` is hoisted, so the factory has to reach the mocks through this
 * module rather than through variables in the spec.
 */
export function wizardApiClientMock() {
  return {
    api: {
      getSources: (days: number) => wizardApiMocks.getSources(days),
      getCategoriesConfig: () => wizardApiMocks.getCategoriesConfig(),
    },
  }
}

/** The factory for `vi.mock('../../store/configStore', wizardConfigStoreMock)`: a configured endpoint. */
export function wizardConfigStoreMock() {
  return {
    useConfigStore: vi.fn(() => ({
      config: { apiEndpoint: 'https://api.example.com' },
    })),
  }
}
