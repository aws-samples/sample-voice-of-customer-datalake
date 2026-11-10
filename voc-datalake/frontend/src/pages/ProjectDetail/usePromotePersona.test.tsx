/**
 * @fileoverview "Promote to company" (5.60): outside a project there is nothing to promote, so the
 * request refuses before any call instead of sending `/projects//personas/…`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { createQueryWrapper } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { usePromotePersona, NotAProjectPersonaError } = await import('./usePromotePersona')

beforeEach(() => {
  resetFetchApi()
  route({ 'POST /projects/proj_1/personas/p1/promote': () => ({ success: true }) })
})

describe('usePromotePersona', () => {
  it('promotes a project persona', async () => {
    const { result } = renderHook(() => usePromotePersona({ projectId: 'proj_1', personaId: 'p1' }), { wrapper: createQueryWrapper() })

    await act(() => result.current.mutateAsync())

    expect(fetchApi).toHaveBeenCalledWith('/projects/proj_1/personas/p1/promote', expect.objectContaining({ method: 'POST' }))
  })

  it('refuses outside a project and sends nothing', async () => {
    const { result } = renderHook(() => usePromotePersona({ projectId: null, personaId: 'p1' }), { wrapper: createQueryWrapper() })

    await expect(act(() => result.current.mutateAsync())).rejects.toBeInstanceOf(NotAProjectPersonaError)
    expect(fetchApi).not.toHaveBeenCalled()
  })
})
