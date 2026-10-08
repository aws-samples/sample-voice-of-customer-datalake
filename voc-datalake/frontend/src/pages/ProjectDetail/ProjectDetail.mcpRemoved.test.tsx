/**
 * @fileoverview The per-project Export / MCP tab is gone; the global MCP on
 * /connect replaces it (owner: "remove the export/mcp from project since we have
 * it globally").
 *
 * Mounted through the page, not ProjectTabs alone, so it also proves an old
 * bookmark (`?tab=mcp`) lands on Overview instead of a blank tab, that nothing on
 * the page still offers a per-project token or `mcp.json`, and that the header's
 * "Connect via MCP" link sends people to the global page pinned to this project.
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import {
  beforeAll, beforeEach, describe, expect, it, vi,
} from 'vitest'
import ProjectDetail from './ProjectDetail'
import { PAGE_PROJECT, createQueryClient } from './project-detail-fixtures'
import { renderProjectDetailPage as renderAt } from './project-detail-page-fixtures'
import { configureApiEndpoint, pageApi as api, stubPageReads } from './page-api-fixtures'

vi.mock('../../api/projectsApi', () => import('./page-api-fixtures').then((m) => ({ projectsApi: m.pageApi })))

/** Shows the router's current search string, so a URL rewrite is observable. */
function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>
}

/**
 * The shared page helper plus a location probe. Kept local: only this spec reads
 * the URL back, and the shared helper would otherwise render a probe for all.
 */
function renderWithLocation(url: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/projects/:id" element={<ProjectDetail />} /></Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ProjectDetail without the Export / MCP tab', () => {
  beforeAll(configureApiEndpoint)
  beforeEach(() => {
    stubPageReads()
    api.getProject.mockResolvedValue({ project: PAGE_PROJECT, personas: [], documents: [] })
  })

  it('offers only Overview, Personas, Product and Documents', async () => {
    renderAt('/projects/proj-1')
    await screen.findByRole('tablist')
    const names = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(names).toHaveLength(4)
    expect(names.join(' ')).not.toMatch(/MCP|Export/)
  })

  it('sends an old ?tab=mcp bookmark to Overview, with no token or mcp.json UI anywhere', async () => {
    renderWithLocation('/projects/proj-1?tab=mcp')
    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('overview-cards')).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent(/^$/))
    // Old tab's markers: the mcp.json snippet, mint and copy-context buttons, the snippet region.
    expect([
      screen.queryByText(/mcp\.json/i),
      screen.queryByRole('button', { name: /generate token|copy context/i }),
      screen.queryByRole('region', { name: /MCP configuration/i }),
    ]).toStrictEqual([null, null, null])
  })

  it('links to the global Connect page, pinned to this project', async () => {
    renderAt('/projects/proj-1')
    const link = await screen.findByRole('link', { name: /Connect via MCP/ })
    expect(link).toHaveAttribute('href', `/connect?project=${PAGE_PROJECT.project_id}`)
  })
})
