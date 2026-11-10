/**
 * @fileoverview A cache reader never breaks the page query it reads.
 *
 * 5.34.00 live: after Run now or a run decision the agent page showed "This agent doesn't
 * exist" until a reload. The breadcrumb and the assistant read the agent through a
 * `useQuery({ queryFn: skipToken })` observer; when one re-rendered after the page it handed
 * the query its skipToken options, and the page's invalidation then "fetched" with no
 * queryFn: an error, no request. `useCachedQueryData` subscribes to the cache instead.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useCachedQueryData } from './useCachedQueryData'

const KEY = ['agents', 'detail', 'ag_1'] as const

function Page({ load }: Readonly<{ load: () => Promise<{ name: string }> }>) {
  const query = useQuery({ queryKey: KEY, queryFn: load })
  if (query.isError) return <p>error</p>
  return <p>{query.data?.name ?? 'loading'}</p>
}

/** A header that re-renders on its own (as Breadcrumbs does on every navigation). */
function Header({ enabled = true }: Readonly<{ enabled?: boolean }>) {
  const [clicks, setClicks] = useState(0)
  const data = useCachedQueryData(KEY, enabled)
  const name = typeof data === 'object' && data !== null && 'name' in data ? String(data.name) : 'none'
  return <button type="button" onClick={() => setClicks(clicks + 1)}>{`crumb ${name} ${clicks}`}</button>
}

function setup(enabled = true) {
  const load = vi.fn(() => Promise.resolve({ name: `Scout ${load.mock.calls.length}` }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><Page load={load} /><Header enabled={enabled} /></QueryClientProvider>)
  return { client, calls: () => load.mock.calls.length }
}

describe('useCachedQueryData', () => {
  it('a header re-rendering after the page leaves the page refetchable', async () => {
    const { client, calls } = setup()
    await screen.findByText('Scout 1')
    fireEvent.click(screen.getByRole('button'))

    await act(async () => { await client.invalidateQueries({ queryKey: KEY }) })

    await waitFor(() => expect(screen.getByText('Scout 2')).toBeInTheDocument())
    expect(screen.queryByText('error')).not.toBeInTheDocument()
    expect(calls()).toBe(2)
  })

  it('follows the cache entry live and never fetches it', async () => {
    const { client, calls } = setup()
    expect(await screen.findByText('crumb Scout 1 0')).toBeInTheDocument()

    act(() => { client.setQueryData(KEY, { name: 'Renamed' }) })

    expect(screen.getByText('crumb Renamed 0')).toBeInTheDocument()
    expect(calls()).toBe(1)
  })

  it('reads nothing while disabled', async () => {
    setup(false)
    await screen.findByText('Scout 1')
    expect(screen.getByText('crumb none 0')).toBeInTheDocument()
  })
})
