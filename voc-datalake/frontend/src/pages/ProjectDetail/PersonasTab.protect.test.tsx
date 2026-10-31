/**
 * @fileoverview Protect a persona from the Personas tab (ported from #429 by @aws-bryan): the lock
 * saves through `PUT .../protection`, the shown state is the loaded project's (not the click-time
 * copy), and the spinner belongs to the persona being saved (bbdc635a).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import PersonasTab from './PersonasTab'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ComponentProps } from 'react'

const setPersonaProtected = vi.hoisted(() => vi.fn())
vi.mock('../../api/projectsApi', () => ({
  projectsApi: { setPersonaProtected, regeneratePersonaAvatar: vi.fn() },
}))

const ada: ProjectPersona = { persona_id: 'p-ada', name: 'Ada Moreno', tagline: 'Plans ahead', created_at: '' }
const grace: ProjectPersona = { persona_id: 'p-grace', name: 'Grace Okafor', tagline: 'Flies weekly', created_at: '' }

function props(overrides: Partial<ComponentProps<typeof PersonasTab>> = {}): ComponentProps<typeof PersonasTab> {
  return {
    projectId: 'proj_1', personas: [ada, grace], canEdit: true, selectedPersona: ada,
    onSelectPersona: vi.fn(), onEditPersona: vi.fn(), onDeletePersona: vi.fn(), onSaveNotes: vi.fn(),
    onGeneratePersonas: vi.fn(), onImportPersona: vi.fn(), isDeleting: false, isSavingNotes: false,
    ...overrides,
  }
}

const lockButton = (name: RegExp) => screen.getByRole('button', { name })

describe('PersonasTab protect toggle', () => {
  beforeEach(() => { setPersonaProtected.mockReset() })

  it('protects the selected persona', async () => {
    setPersonaProtected.mockResolvedValue({ success: true })
    renderWithQueryClient(<PersonasTab {...props()} />)
    const toggle = lockButton(/^Protect this persona/)
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.setup().click(toggle)
    expect(setPersonaProtected).toHaveBeenCalledWith('proj_1', 'p-ada', true)
  })

  it('shows the loaded project\'s state, not the click-time copy', () => {
    // Selected before it was protected; the project has since reloaded with protected: true.
    renderWithQueryClient(<PersonasTab {...props({ personas: [{ ...ada, protected: true }, grace] })} />)
    expect(lockButton(/^Stop protecting/)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText('Protected').length).toBeGreaterThan(0)
  })

  it('marks a protected persona in the list', () => {
    renderWithQueryClient(<PersonasTab {...props({ personas: [ada, { ...grace, protected: true }] })} />)
    const graceCard = screen.getByRole('button', { name: /^Grace Okafor/ })
    expect(within(graceCard).getByLabelText('Protected')).toBeInTheDocument()
  })

  it('keeps the spinner on the persona being saved when another one is selected', async () => {
    setPersonaProtected.mockReturnValue(new Promise(() => {}))
    const view = renderWithQueryClient(<PersonasTab {...props()} />)
    await userEvent.setup().click(lockButton(/^Protect this persona/))
    expect(lockButton(/^Protect this persona/)).toBeDisabled()

    view.rerender(<PersonasTab {...props({ selectedPersona: grace })} />)
    expect(lockButton(/^Protect this persona/)).toBeEnabled()
    view.rerender(<PersonasTab {...props({ selectedPersona: ada })} />)
    expect(lockButton(/^Protect this persona/)).toBeDisabled()
  })

  it('says when the save failed', async () => {
    setPersonaProtected.mockRejectedValue(new Error('API Error: 500'))
    renderWithQueryClient(<PersonasTab {...props()} />)
    await userEvent.setup().click(lockButton(/^Protect this persona/))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not change the protection')
  })

  it('offers no toggle to a viewer', () => {
    renderWithQueryClient(<PersonasTab {...props({ canEdit: false, personas: [{ ...ada, protected: true }, grace] })} />)
    expect(screen.queryByRole('button', { name: /protect/i })).toBeNull()
    expect(screen.getAllByText('Protected').length).toBeGreaterThan(0)
  })
})
