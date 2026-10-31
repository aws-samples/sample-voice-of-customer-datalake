/**
 * @fileoverview "Promote to company" (5.60): outside a project there is nothing to promote, so the
 * request refuses before any call instead of sending `/projects//personas/…`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createTestQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { usePromotePersona } = await import('./usePromotePersona')

function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

beforeEach(() => {
  resetFetchApi()
  route({ 'POST /projects/proj_1/personas/p1/promote': () => ({ success: true }) })
})

describe('usePromotePersona', () => {
  it('promotes a project persona', async () => {
    const { result } = renderHook(() => usePromotePersona({ projectId: 'proj_1', personaId: 'p1' }), { wrapper: Wrapper })

    await act(() => result.current.mutateAsync())

    expect(fetchApi).toHaveBeenCalledWith('/projects/proj_1/personas/p1/promote', expect.objectContaining({ method: 'POST' }))
  })

  it.each([null, ''])('refuses without a project (%j) and sends nothing', async (projectId) => {
    const { result } = renderHook(() => usePromotePersona({ projectId, personaId: 'p1' }), { wrapper: Wrapper })

    await expect(act(() => result.current.mutateAsync())).rejects.toThrow('Only a project persona can be promoted')
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
