/**
 * The header readers of the project entry (Breadcrumbs, the assistant's page context)
 * must never stop the page's own query from refetching. They used to observe it with
 * `queryFn: skipToken`; the query then ran the reader's `skipToken` on every
 * invalidation, so the Share dialog's Public → Private never reached the header badge.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { projectKey } from '../api/projectQueryKeys'
import { usePageContext } from '../assistant/page/usePageContext'
import Breadcrumbs from '../components/Breadcrumbs/Breadcrumbs'
import { createTestQueryClient } from '../test/query-client'
import { TestRouter } from '../test/TestRouter'
import { useCachedQueryData } from './useCachedQueryData'

const PROJECT_ID = 'proj_1'
const VisibilitySchema = z.object({ project: z.object({ visibility: z.string() }) })

function detail(visibility: string) {
  return { project: { project_id: PROJECT_ID, name: 'Checkout', visibility }, personas: [], documents: [] }
}

/** The page's own query, as useProjectData declares it. */
function PageProbe({ getProject }: Readonly<{ getProject: () => Promise<unknown> }>) {
  const { data } = useQuery({ queryKey: projectKey(PROJECT_ID), queryFn: getProject })
  const visibility = VisibilitySchema.safeParse(data).data?.project.visibility
  return <p data-testid="badge">{visibility ?? 'loading'}</p>
}

function PageContextReader() {
  const context = usePageContext()
  return <p data-testid="title">{context.title ?? ''}</p>
}

function renderPage(getProject: () => Promise<unknown>) {
  const queryClient = createTestQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
        <Breadcrumbs />
        <PageContextReader />
        <PageProbe getProject={getProject} />
      </TestRouter>
    </QueryClientProvider>,
  )
  return queryClient
}

describe('useCachedQueryData', () => {
  it('a project page beside the header readers refetches on every invalidation, so a visibility change shows', async () => {
    const getProject = vi.fn()
      .mockResolvedValueOnce(detail('public'))
      .mockResolvedValueOnce(detail('private'))
      .mockResolvedValueOnce(detail('public'))
    const queryClient = renderPage(getProject)
    await waitFor(() => expect(screen.getByTestId('badge')).toHaveTextContent('public'))
    await act(() => queryClient.invalidateQueries({ queryKey: projectKey(PROJECT_ID) }))
    await waitFor(() => expect(screen.getByTestId('badge')).toHaveTextContent('private'))
    await act(() => queryClient.invalidateQueries({ queryKey: projectKey(PROJECT_ID) }))
    await waitFor(() => expect(getProject).toHaveBeenCalledTimes(3))
  })

  it('the header readers follow the entry the page fills, without a request of their own', async () => {
    const getProject = vi.fn().mockResolvedValue(detail('public'))
    renderPage(getProject)
    await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('Checkout'))
    expect(screen.getByRole('navigation', { name: /breadcrumb/i })).toHaveTextContent('Checkout')
    expect(getProject).toHaveBeenCalledTimes(1)
  })

  it('reads nothing while disabled', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(['k'], 'value')
    function Reader({ enabled }: Readonly<{ enabled: boolean }>) {
      const data = useCachedQueryData(['k'], enabled)
      return <p data-testid="value">{typeof data === 'string' ? data : 'none'}</p>
    }
    const { rerender } = render(<QueryClientProvider client={queryClient}><Reader enabled={false} /></QueryClientProvider>)
    expect(screen.getByTestId('value')).toHaveTextContent('none')
    rerender(<QueryClientProvider client={queryClient}><Reader enabled /></QueryClientProvider>)
    expect(screen.getByTestId('value')).toHaveTextContent('value')
  })
})
