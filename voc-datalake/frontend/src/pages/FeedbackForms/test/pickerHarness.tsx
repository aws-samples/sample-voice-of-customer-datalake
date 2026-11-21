/**
 * @fileoverview Test support for the template picker: the picker at `/feedback-forms/new`, and a stand-in builder at
 * `/feedback-forms/new/questions` that shows the new form it was handed (pickerRoutes.tsx).
 *
 * @module pages/FeedbackForms/test/pickerHarness
 */
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { BuilderStandIn, PickerAtUrl } from './pickerRoutes'

/**
 * Render the picker at `/feedback-forms/new` with `search` (`?template=nps`) and `state` as the history state it opens
 * with (the builder's Discard draft brings `{ describe }`).
 */
export function renderPicker({ search = '', state }: Readonly<{ search?: string; state?: unknown }> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: '/feedback-forms/new', search, state }]}>
        <Routes>
          <Route path="/feedback-forms/new" element={<PickerAtUrl />} />
          <Route path="/feedback-forms/new/questions" element={<BuilderStandIn />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
