/**
 * @fileoverview Spec support for the Wizards.tsx specs (Doc, Research, Persona).
 *
 * Every wizard renders the shared DataSourceWizard, which reads sources and
 * categories through `api` and the API endpoint through the config store, so all
 * three specs mock those two modules with the DataSourceWizard spec factories
 * (`wizardApiClientMock`, `wizardConfigStoreMock` in
 * `components/DataSourceWizard/dataSourceWizard-fixtures`), reset them the same
 * way and render under the same QueryClient wrapper.
 */
import { vi } from 'vitest'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { defaultContextConfig } from '../../components/DataSourceWizard/types'
import { wizardApiMocks } from '../../components/DataSourceWizard/dataSourceWizard-fixtures'

/** The `beforeEach` every wizard spec runs: clear mocks, then an empty workspace. */
export function resetWizardMocks() {
  vi.clearAllMocks()
  wizardApiMocks.getSources.mockResolvedValue({ sources: {} })
  wizardApiMocks.getCategoriesConfig.mockResolvedValue({ categories: [] })
}

/** A render `wrapper` providing a fresh, non-retrying QueryClient. */
export function createWizardWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

/** The props every wizard shares; each spec spreads its tool-specific config on top. */
export function baseWizardProps() {
  return {
    projectId: 'proj-1',
    personas: [],
    documents: [],
    contextConfig: defaultContextConfig,
    generating: null,
    onContextChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  }
}
