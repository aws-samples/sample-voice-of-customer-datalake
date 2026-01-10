import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PersonasTab from './PersonasTab'
import type { ProjectPersona } from '../../api/client'

const mockPersona: ProjectPersona = {
  persona_id: '1',
  name: 'TestUser',
  description: 'A test persona',
  tagline: 'Test tagline',
}

const defaultProps = {
  personas: [] as ProjectPersona[],
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
    render(<PersonasTab {...defaultProps} />)
    expect(screen.getByText('No personas yet')).toBeInTheDocument()
    expect(screen.getByText('Generate personas from feedback')).toBeInTheDocument()
  })

  it('renders Generate Personas button', () => {
    render(<PersonasTab {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Generate Personas/i })).toBeInTheDocument()
  })

  it('renders Import Persona button', () => {
    render(<PersonasTab {...defaultProps} />)
    expect(screen.getByRole('button', { name: /Import Persona/i })).toBeInTheDocument()
  })

  it('calls onGeneratePersonas when Generate button is clicked', async () => {
    const user = userEvent.setup()
    const onGeneratePersonas = vi.fn()
    render(<PersonasTab {...defaultProps} onGeneratePersonas={onGeneratePersonas} />)
    
    await user.click(screen.getByRole('button', { name: /Generate Personas/i }))
    expect(onGeneratePersonas).toHaveBeenCalledTimes(1)
  })

  it('calls onImportPersona when Import button is clicked', async () => {
    const user = userEvent.setup()
    const onImportPersona = vi.fn()
    render(<PersonasTab {...defaultProps} onImportPersona={onImportPersona} />)
    
    await user.click(screen.getByRole('button', { name: /Import Persona/i }))
    expect(onImportPersona).toHaveBeenCalledTimes(1)
  })

  it('renders persona list when personas exist', () => {
    render(<PersonasTab {...defaultProps} personas={[mockPersona]} />)
    expect(screen.getByText('@TestUser')).toBeInTheDocument()
    expect(screen.getByText('Test tagline')).toBeInTheDocument()
  })

  it('shows select message when no persona selected', () => {
    render(<PersonasTab {...defaultProps} personas={[mockPersona]} />)
    expect(screen.getByText('Select a persona to view details')).toBeInTheDocument()
  })

  it('calls onSelectPersona when persona is clicked', async () => {
    const user = userEvent.setup()
    const onSelectPersona = vi.fn()
    render(<PersonasTab {...defaultProps} personas={[mockPersona]} onSelectPersona={onSelectPersona} />)
    
    const buttons = screen.getAllByRole('button')
    const personaButton = buttons.find(b => b.textContent?.includes('@TestUser'))
    await user.click(personaButton!)
    expect(onSelectPersona).toHaveBeenCalledWith(mockPersona)
  })

  it('highlights selected persona', () => {
    render(<PersonasTab {...defaultProps} personas={[mockPersona]} selectedPersona={mockPersona} />)
    const buttons = screen.getAllByRole('button')
    const personaButton = buttons.find(b => b.textContent?.includes('@TestUser'))
    expect(personaButton).toHaveClass('bg-purple-50', 'border-purple-300')
  })

  it('calls onGeneratePersonas from empty state button', async () => {
    const user = userEvent.setup()
    const onGeneratePersonas = vi.fn()
    render(<PersonasTab {...defaultProps} onGeneratePersonas={onGeneratePersonas} />)
    
    // Click the Generate button in empty state
    const buttons = screen.getAllByRole('button', { name: /Generate/i })
    await user.click(buttons[buttons.length - 1]) // Last one is in empty state
    expect(onGeneratePersonas).toHaveBeenCalled()
  })
})
