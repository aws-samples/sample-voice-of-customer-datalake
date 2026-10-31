/**
 * @fileoverview `prefetch` keeps `prefetchQuery`'s contract on top of `queryClient.query`: the data lands in
 * the cache, a fresh entry is not fetched again, and a failed fetch never rejects.
 */
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { prefetch } from './prefetch'

const KEY = ['prefetch-test'] as const

describe('prefetch', () => {
  it('puts the fetched data in the cache and resolves with nothing', async () => {
    const client = new QueryClient()
    await expect(prefetch(client, { queryKey: KEY, queryFn: () => Promise.resolve({ n: 1 }) })).resolves.toBeUndefined()
    expect(client.getQueryData(KEY)).toStrictEqual({ n: 1 })
  })

  it('does not fetch again while the cached entry is fresh', async () => {
    const client = new QueryClient()
    const queryFn = vi.fn(() => Promise.resolve('data'))
    await prefetch(client, { queryKey: KEY, queryFn, staleTime: 60_000 })
    await prefetch(client, { queryKey: KEY, queryFn, staleTime: 60_000 })
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('resolves when the fetch fails, and leaves nothing cached', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await expect(prefetch(client, { queryKey: KEY, queryFn: () => Promise.reject(new Error('offline')) })).resolves.toBeUndefined()
    expect(client.getQueryData(KEY)).toBeUndefined()
  })
})
