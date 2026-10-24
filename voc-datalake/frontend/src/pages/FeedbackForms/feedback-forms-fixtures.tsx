/**
 * Shared test support for the FeedbackForms page specs.
 *
 * Holds only what more than one spec in this directory needs: the `api/client`
 * mock surface, the config-store stub, and the React Query wrappers. It must
 * NOT import any component under test — the module factories here are called
 * from hoisted `vi.mock(...)` blocks, so the spec has to import this file
 * before the component it exercises.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import type { ReactNode } from 'react'
import { isRecord } from '../../lib/typeGuards'

/** A stub whose return is `unknown` so the module factory below is not "unsafe any". */
const apiStub = () => vi.fn<(...args: unknown[]) => unknown>()

/** One `vi.fn()` per `api.*` member the page and its editor call. */
export const feedbackFormsApiMocks = {
  getFeedbackForms: apiStub(),
  createFeedbackForm: apiStub(),
  updateFeedbackForm: apiStub(),
  deleteFeedbackForm: apiStub(),
  getCategories: apiStub(),
  getCategoriesConfig: apiStub(),
  getFeedbackFormStats: apiStub(),
}

/** Module factory for `vi.mock('../../api/client', () => clientApiModule())`. */
export function clientApiModule() {
  return {
    api: {
      getFeedbackForms: () => feedbackFormsApiMocks.getFeedbackForms(),
      // The page's list read: the same stubbed payload, shaped like the real
      // client's (`forms` raw, `stats` map or null).
      getFeedbackFormsWithStats: async () => {
        const raw = await feedbackFormsApiMocks.getFeedbackForms()
        const record: Readonly<Record<string, unknown>> = isRecord(raw) ? raw : {}
        return { forms: record['forms'], stats: record['stats'] ?? null }
      },
      getFeedbackFormStats: (id: string) => feedbackFormsApiMocks.getFeedbackFormStats(id),
      createFeedbackForm: (form: unknown) => feedbackFormsApiMocks.createFeedbackForm(form),
      updateFeedbackForm: (id: string, form: unknown) => feedbackFormsApiMocks.updateFeedbackForm(id, form),
      deleteFeedbackForm: (id: string) => feedbackFormsApiMocks.deleteFeedbackForm(id),
      getCategories: () => feedbackFormsApiMocks.getCategories(),
      getCategoriesConfig: () => feedbackFormsApiMocks.getCategoriesConfig(),
    },
  }
}

/** Module factory for `vi.mock('../../store/configStore', () => configStoreModule())`. */
export const CONFIGURED_API_ENDPOINT = 'https://api.example.com'

/** The endpoint the mocked store reports, read on every call; a spec may blank it and must restore it. */
export const formsConfigState = { apiEndpoint: CONFIGURED_API_ENDPOINT }

export function configStoreModule() {
  return {
    useConfigStore: () => ({ config: { apiEndpoint: formsConfigState.apiEndpoint } }),
  }
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

/** React Query provider plus a MemoryRouter, for specs that render the page. */
export function createFormsWrapper() {
  const queryClient = newQueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

/** React Query provider only, for specs that render a card in isolation. */
export function createQueryWrapper() {
  const queryClient = newQueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}
