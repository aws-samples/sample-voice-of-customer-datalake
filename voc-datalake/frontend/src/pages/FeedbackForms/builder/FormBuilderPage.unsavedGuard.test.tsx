/**
 * @fileoverview The forms builder (FormBuilderPage) under the shared unsaved-changes guard, through the shared
 * contract (3.00.00 R2): an edit to the draft survives a refetch of the stored form while the dialog is open,
 * Cancel keeps it, and the next leave asks again.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { FormV2, LoadedForm } from '../model/formsV2'

const api = vi.hoisted(() => ({
  getForm: vi.fn<(formId: string) => Promise<LoadedForm>>(),
}))

vi.mock('../preview/PreviewFrame', async () => import('../test/previewFrameStub'))
vi.mock('../../../store/configStore', async () => (await import('../feedback-forms-fixtures')).configStoreModule())
vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) =>
  (await import('../test/formsApiMock')).formsApiWith(importOriginal, api))
vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

import FormBuilderPage from './FormBuilderPage'
import { STORED_META, sampleForm } from '../test/draftHarness'

const SETTINGS = '/feedback-forms/f_test/settings'
const stored = (form: FormV2, revision: number): LoadedForm => ({ form, meta: { ...STORED_META, revision } })

/** The builder on a stored form's Settings tab, with a way out ("Leave" to another page). */
function mountBuilder() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter([
    { path: SETTINGS, element: <><Link to="/elsewhere">Leave</Link><FormBuilderPage formId="f_test" tab="settings" rest={[]} /></> },
    { path: '/elsewhere', element: <p>Elsewhere page</p> },
  ], { initialEntries: [SETTINGS] })
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)
  return { queryClient, router }
}

describe('FormBuilderPage — Cancel keeps the draft and stays guarded (R2 contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getForm.mockResolvedValue(stored(sampleForm(), 3))
  })

  it('keeps a renamed draft through a refetch of the stored form while the dialog is open', async () => {
    const mounted: Partial<ReturnType<typeof mountBuilder>> = {}
    await expectCancelKeepsDraftGuarded({
      mount: async () => {
        Object.assign(mounted, mountBuilder())
        await screen.findByLabelText('Internal name')
      },
      edit: async (user) => {
        const name = screen.getByLabelText('Internal name')
        await user.clear(name)
        await user.type(name, 'Pilot form')
      },
      expectDraft: () => expect(screen.getByLabelText('Internal name')).toHaveValue('Pilot form'),
      leave: async (user) => { await user.click(screen.getByRole('link', { name: 'Leave' })) },
      expectStayed: () => expect(mounted.router?.state.location.pathname).toBe(SETTINGS),
      expectLeft: async () => { expect(await screen.findByText('Elsewhere page')).toBeInTheDocument() },
      // Someone else saved: the stored form changed, and the page's query refetches it.
      whileDialogOpen: async () => {
        api.getForm.mockResolvedValue(stored(sampleForm({ name: 'Saved elsewhere' }), 4))
        await mounted.queryClient?.invalidateQueries()
      },
    })
    expect(api.getForm).toHaveBeenCalledTimes(2)
  })
})
