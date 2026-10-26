/**
 * @fileoverview Render helper for the specs that mount the whole ProjectDetail page.
 *
 * Imports the page, so it must not be used by a `vi.mock` factory — the page
 * specs keep their own inline factories because each mocks a different slice of
 * `projectsApi`.
 */
import { render } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ProjectDetail from './ProjectDetail'
import { createQueryClient } from './project-detail-fixtures'

/**
 * Mounts the page at `url` (default `/projects/proj-1`) under a fresh,
 * non-retrying QueryClient. `url` may carry a query, e.g. `?tab=documents`.
 */
export function renderProjectDetailPage(url = '/projects/proj-1') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/projects/:id" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
