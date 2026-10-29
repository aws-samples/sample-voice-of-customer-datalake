/**
 * #353: a project with personas chooses whether a new generation adds to them (the
 * default, non-destructive) or replaces them; replace confirms as a danger dialog that
 * counts what it deletes, and the request carries `keep_existing_personas` to match.
 */
import type { ReactNode } from 'react'
import { useState } from 'react'
import { act, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTestQueryClient } from '../../test/query-client'
import { PersonaGenerateConfirm, PersonaModeChoice } from './PersonaModeChoice'
import { useProjectMutations } from './useProjectData'
import { useProjectWizardState } from './useProjectWizardState'
import type { PersonaGenerationMode } from './types'

const generatePersonas = vi.hoisted(() => vi.fn<(projectId: string, body: { keep_existing_personas?: boolean }) => Promise<unknown>>())
vi.mock('../../api/projectsApi', () => ({ projectsApi: { generatePersonas } }))

function Choice({ existingCount }: { readonly existingCount: number }) {
  const [mode, setMode] = useState<PersonaGenerationMode>('add')
  return (
    <>
      <PersonaModeChoice existingCount={existingCount} mode={mode} onChange={setMode} />
      <PersonaGenerateConfirm
        isOpen existingCount={existingCount} mode={mode} personaCount={3}
        onConfirm={() => undefined} onCancel={() => undefined}
      />
    </>
  )
}

describe('the add-or-replace choice', () => {
  it('is not offered to a project without personas, which then gets the plain confirmation', () => {
    render(<Choice existingCount={0} />)
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Generate personas now?' })).toBeInTheDocument()
  })

  it('defaults to adding, which keeps the existing personas and asks without a warning', () => {
    render(<Choice existingCount={2} />)
    expect(screen.getByRole('radio', { name: /Add to existing personas/ })).toBeChecked()
    expect(screen.getByText(/Keeps the 2 personas this project has/)).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Generate personas now?' })).toBeInTheDocument()
  })

  it('turns the confirmation into a delete warning that counts the personas when replacing', async () => {
    const user = userEvent.setup()
    render(<Choice existingCount={2} />)
    await user.click(screen.getByRole('radio', { name: /Replace existing personas/ }))
    const dialog = screen.getByRole('dialog', { name: 'Replace the existing personas?' })
    expect(dialog).toHaveTextContent("deletes the project's 2 existing personas")
    expect(screen.getByRole('button', { name: 'Delete and generate' })).toBeInTheDocument()
  })

  it('names a single persona in the singular', () => {
    render(<Choice existingCount={1} />)
    expect(screen.getByText(/Keeps the 1 persona this project has and writes new, clearly different ones next to it\./)).toBeInTheDocument()
  })
})

describe('the generate request', () => {
  beforeEach(() => {
    generatePersonas.mockReset()
    generatePersonas.mockResolvedValue({ success: true, job_id: 'job_1', status: 'running', message: '' })
  })

  function wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
  }

  async function sentKeep(mode?: PersonaGenerationMode): Promise<boolean | undefined> {
    const { result } = renderHook(() => {
      const wizard = useProjectWizardState()
      const mutations = useProjectMutations({ id: 'proj_1', ...wizard, onSuccess: () => undefined, onError: () => undefined })
      return { wizard, mutations }
    }, { wrapper })
    if (mode) act(() => { result.current.wizard.setPersonaConfig((c) => ({ ...c, mode })) })
    await act(async () => { await result.current.mutations.personaMut.mutateAsync() })
    return generatePersonas.mock.calls[0]?.[1].keep_existing_personas
  }

  it('keeps the existing personas by default', async () => {
    expect(await sentKeep()).toBe(true)
  })

  it('asks the server to replace them when replace was chosen', async () => {
    expect(await sentKeep('replace')).toBe(false)
  })
})
