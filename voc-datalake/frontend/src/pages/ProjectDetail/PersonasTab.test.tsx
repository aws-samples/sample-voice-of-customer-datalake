import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient } from '../../test/query-client'
import userEvent from '@testing-library/user-event'
import PersonasTab from './PersonasTab'
import type { ProjectPersona } from '../../api/projectTypes'
import { required } from '../../components/component-spec-fixtures'

const mockPersona: ProjectPersona = {
  persona_id: '1',
  name: 'TestUser',
  tagline: 'Test tagline',
  created_at: '',
}

const noPersonas: ProjectPersona[] = []

const defaultProps = {
  projectId: 'proj_1',
  personas: noPersonas,
  canEdit: true,
  selectedPersona: null,
  onSelectPersona: vi.fn(),
  onEditPersona: vi.fn(),
  onDeletePersona: vi.fn(),
  onSaveNotes: vi.fn(),
  onGeneratePersonas: vi.fn(),
  onImportPersona: vi.fn(),
  isDeleting: false,
  isSavingNotes: false,
}

describe('PersonasTab', () => {
  it('renders empty state when no personas', () => {
    renderWithQueryClient(<PersonasTab {...defaultProps} />)
    expect(screen.getByText('No personas yet')).toBeInTheDocument()
    expect(screen.getByText('Generate personas from feedback')).toBeInTheDocument()
  })

  it('renders Generate Personas button', () => {
    renderWithQueryClient(<PersonasTab {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Generate Personas/i })).toBeInTheDocument()
  })

  it('renders Import Persona button', () => {
    renderWithQueryClient(<PersonasTab {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Import Persona/i })).toBeInTheDocument()
  })

  it('calls onGeneratePersonas when Generate button is clicked', async () => {
    const user = userEvent.setup()
    const onGeneratePersonas = vi.fn()
    renderWithQueryClient(<PersonasTab {...defaultProps} onGeneratePersonas={onGeneratePersonas} />)
    
    await user.click(screen.getByRole('button', { name: /Generate Personas/i }))
    expect(onGeneratePersonas).toHaveBeenCalledTimes(1)
  })

  it('calls onImportPersona when Import button is clicked', async () => {
    const user = userEvent.setup()
    const onImportPersona = vi.fn()
    renderWithQueryClient(<PersonasTab {...defaultProps} onImportPersona={onImportPersona} />)
    
    await user.click(screen.getByRole('button', { name: /Import Persona/i }))
    expect(onImportPersona).toHaveBeenCalledTimes(1)
  })

  it('renders persona list when personas exist', () => {
    renderWithQueryClient(<PersonasTab {...defaultProps} personas={[mockPersona]} />)
    expect(screen.getByText('@TestUser')).toBeInTheDocument()
    expect(screen.getByText('Test tagline')).toBeInTheDocument()
  })

  it('shows select message when no persona selected', () => {
    renderWithQueryClient(<PersonasTab {...defaultProps} personas={[mockPersona]} />)
    expect(screen.getByText('Select a persona to view details')).toBeInTheDocument()
  })

  it('calls onSelectPersona when persona is clicked', async () => {
    const user = userEvent.setup()
    const onSelectPersona = vi.fn()
    renderWithQueryClient(<PersonasTab {...defaultProps} personas={[mockPersona]} onSelectPersona={onSelectPersona} />)
    
    await user.click(screen.getByRole('button', { name: /@TestUser/ }))
    expect(onSelectPersona).toHaveBeenCalledWith(mockPersona)
  })

  it('highlights selected persona', () => {
    renderWithQueryClient(<PersonasTab {...defaultProps} personas={[mockPersona]} selectedPersona={mockPersona} />)
    expect(screen.getByRole('button', { name: /@TestUser/ })).toHaveClass('bg-accent-subtle', 'border-accent/40')
  })

  it('calls onGeneratePersonas from empty state button', async () => {
    const user = userEvent.setup()
    const onGeneratePersonas = vi.fn()
    renderWithQueryClient(<PersonasTab {...defaultProps} onGeneratePersonas={onGeneratePersonas} />)
    
    // Click the Generate button in empty state
    const buttons = screen.getAllByRole('button', { name: /Generate/i })
    await user.click(required(buttons.at(-1), 'the empty-state Generate button')) // Last one is in empty state
    expect(onGeneratePersonas).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'click' }))
  })

  // A viewer (`project.access.can_edit === false`) sees the personas but is offered
  // none of the controls whose request the project gate would refuse with 403.
  describe('for a viewer (canEdit false)', () => {
    it('offers no Import / Generate controls, and no call to action in the empty state', () => {
      renderWithQueryClient(<PersonasTab {...defaultProps} canEdit={false} />)
      expect(screen.getByText('No personas yet')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Generate/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Import Persona/i })).not.toBeInTheDocument()
    })

    it('shows the selected persona without Edit, Delete or research-note controls', () => {
      renderWithQueryClient(<PersonasTab {...defaultProps} canEdit={false} personas={[mockPersona]} selectedPersona={mockPersona} />)
      expect(screen.getByRole('heading', { name: '@TestUser' })).toBeInTheDocument()
      const offered = [/Edit persona/i, /Delete persona/i, /Add note/i]
        .filter((name) => screen.queryByRole('button', { name }) !== null)
      expect(offered).toStrictEqual([])
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('still lists existing research notes, read-only', () => {
      const noted = { ...mockPersona, research_notes: ['Prefers email over phone'] }
      renderWithQueryClient(<PersonasTab {...defaultProps} canEdit={false} personas={[noted]} selectedPersona={noted} />)
      expect(screen.getByText('Prefers email over phone')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Remove note/i })).not.toBeInTheDocument()
    })
  })

  it('as an editor, keeps Edit, Delete and the research-note input on the selected persona', () => {
    renderWithQueryClient(<PersonasTab {...defaultProps} personas={[mockPersona]} selectedPersona={mockPersona} />)
    expect(screen.getByRole('button', { name: /Edit persona/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Delete persona/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add note/i })).toBeInTheDocument()
  })
})
