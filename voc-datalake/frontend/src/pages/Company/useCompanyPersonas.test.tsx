/**
 * @fileoverview The company persona library's data hooks (5.60): the library generate start and
 * its refetch when a job finishes, and the shared persona writes on the library scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { createTestQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'
import { defaultContextConfig } from '../../components/DataSourceWizard/types'
import type { ProjectJob, ProjectPersona } from '../../api/projectTypes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { useCompanyPersonas } = await import('./useCompanyPersonas')
const { usePersonaMutations } = await import('../ProjectDetail/usePersonaMutations')
const { COMPANY_PERSONA_SCOPE } = await import('../ProjectDetail/personaScope')

const FARAH: ProjectPersona = {
  persona_id: 'cpersona_1', name: 'Frequent-Flyer Farah', tagline: 'Books Example Air every month',
  created_at: '2026-10-01T00:00:00Z', research_notes: [],
}

function wrapper() {
  const client = createTestQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return { Wrapper, invalidate, client }
}

/** The library hook over an empty, read-only library whose jobs list is ``jobs()`` on every poll. */
function renderLibrary(jobs: () => Array<Partial<ProjectJob>>) {
  route({
    'GET /company-personas': () => ({ personas: [], can_edit: false }),
    'GET /company-personas/jobs': () => ({ jobs: jobs() }),
  })
  const { Wrapper, invalidate, client } = wrapper()
  const { result } = renderHook(() => useCompanyPersonas(), { wrapper: Wrapper })
  const libraryRefetches = () => invalidate.mock.calls.filter(([filters]) => filters?.queryKey?.[0] === 'company-personas')
  return { result, client, libraryRefetches }
}

function sentBody(path: string, method: string): unknown {
  const call = fetchApi.mock.calls.find(([endpoint, options]) => endpoint === path && options?.method === method)
  const body = call?.[1]?.body
  return typeof body === 'string' ? JSON.parse(body) : undefined
}

beforeEach(() => {
  resetFetchApi()
})

describe('useCompanyPersonas', () => {
  it('starts an additive generation from the wizard config and refreshes the jobs', async () => {
    route({
      'GET /company-personas': () => ({ personas: [FARAH], can_edit: true }),
      'GET /company-personas/jobs': () => ({ jobs: [] }),
      'POST /company-personas/generate': () => ({ success: true, job_id: 'job_1', status: 'running', message: '' }),
    })
    const { Wrapper, invalidate } = wrapper()
    const { result } = renderHook(() => useCompanyPersonas(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.personas).toStrictEqual([expect.objectContaining({ persona_id: 'cpersona_1' })]))
    expect(result.current.canEdit).toBe(true)

    await act(() => result.current.generate.mutateAsync({
      contextConfig: { ...defaultContextConfig, sources: ['webscraper'], categories: [], sentiments: ['negative'], days: 30 },
      personaConfig: { personaCount: 2, customInstructions: 'Frequent flyers', mode: 'add' },
    }))

    expect(sentBody('/company-personas/generate', 'POST')).toMatchObject({
      sources: ['webscraper'], sentiments: ['negative'], days: 30, persona_count: 2, custom_instructions: 'Frequent flyers',
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['company-persona-jobs'] })
  })

  it('refetches the library once per finished job, not on every later poll', async () => {
    const completedAt = new Date().toISOString()
    const phase = { progress: 10 }
    const { result, client, libraryRefetches } = renderLibrary(() => [
      { job_id: 'job_1', job_type: 'generate_personas', status: 'completed', completed_at: completedAt },
      { job_id: 'job_2', job_type: 'import_persona', status: 'running', progress: phase.progress },
    ])

    await waitFor(() => expect(result.current.jobs).toHaveLength(2))
    await waitFor(() => expect(libraryRefetches()).toHaveLength(1))

    phase.progress = 60
    await act(() => client.refetchQueries({ queryKey: ['company-persona-jobs'] }))
    await waitFor(() => expect(result.current.jobs[1]?.progress).toBe(60))

    expect(libraryRefetches()).toHaveLength(1)
  })

  it('does not refetch when a handled completion drops out of the jobs list', async () => {
    const now = new Date().toISOString()
    const phase: { jobs: Array<Partial<ProjectJob>> } = { jobs: [
      { job_id: 'job_1', job_type: 'generate_personas', status: 'completed', completed_at: now },
      { job_id: 'job_2', job_type: 'import_persona', status: 'completed', completed_at: now },
    ] }
    const { result, client, libraryRefetches } = renderLibrary(() => phase.jobs)
    await waitFor(() => expect(libraryRefetches()).toHaveLength(1))

    phase.jobs = phase.jobs.slice(1)
    await act(() => client.refetchQueries({ queryKey: ['company-persona-jobs'] }))
    await waitFor(() => expect(result.current.jobs).toHaveLength(1))

    expect(libraryRefetches()).toHaveLength(1)
  })
})

describe('usePersonaMutations on the library', () => {
  function mutations(selected: ProjectPersona | null, editing: ProjectPersona | null) {
    const setEditingPersona = vi.fn()
    const setSelectedPersona = vi.fn()
    const { Wrapper, invalidate } = wrapper()
    const { result } = renderHook(() => usePersonaMutations({
      scope: COMPANY_PERSONA_SCOPE, selectedPersona: selected, editingPersona: editing, setEditingPersona, setSelectedPersona,
    }), { wrapper: Wrapper })
    return { result, setEditingPersona, setSelectedPersona, invalidate }
  }

  beforeEach(() => {
    route({
      'PUT /company-personas/cpersona_1': () => ({ success: true }),
      'DELETE /company-personas/cpersona_1': () => ({ success: true }),
      'POST /company-personas/import': () => ({ success: true, job_id: 'job_2', status: 'running', message: '' }),
    })
  })

  it('saves the edited persona, then closes the editor and the detail', async () => {
    const edited = { ...FARAH, name: 'Farah the Frequent Flyer' }
    const { result, setEditingPersona, setSelectedPersona, invalidate } = mutations(FARAH, edited)

    await act(() => result.current.saveEditingPersona())

    expect(sentBody('/company-personas/cpersona_1', 'PUT')).toMatchObject({ name: 'Farah the Frequent Flyer' })
    expect(setEditingPersona).toHaveBeenCalledWith(null)
    expect(setSelectedPersona).toHaveBeenCalledWith(null)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['company-personas'] })
  })

  it('saves research notes for the selected persona only', async () => {
    const note = { note_id: 'n1', text: 'Prefers aisle seats', author: 'ada', created_at: '2026-10-02T00:00:00Z' }
    const { result } = mutations(FARAH, null)

    act(() => result.current.saveNotes([note]))

    await waitFor(() => expect(sentBody('/company-personas/cpersona_1', 'PUT')).toStrictEqual({ research_notes: [note] }))
  })

  it('saves nothing without a selected or edited persona', async () => {
    const { result } = mutations(null, null)

    act(() => result.current.saveNotes([]))
    await act(() => result.current.saveEditingPersona())

    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('deletes a persona and closes its detail', async () => {
    const { result, setSelectedPersona } = mutations(FARAH, null)

    await act(() => result.current.deletePersonaMut.mutateAsync('cpersona_1'))

    expect(fetchApi).toHaveBeenCalledWith('/company-personas/cpersona_1', expect.objectContaining({ method: 'DELETE' }))
    expect(setSelectedPersona).toHaveBeenCalledWith(null)
  })

  it('starts an import and refreshes the library jobs', async () => {
    const { result, invalidate } = mutations(null, null)

    await act(() => result.current.importPersonaMut.mutateAsync({ input_type: 'text', content: 'A frequent flyer' }))

    expect(sentBody('/company-personas/import', 'POST')).toStrictEqual({ input_type: 'text', content: 'A frequent flyer' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['company-persona-jobs'] })
  })
})
