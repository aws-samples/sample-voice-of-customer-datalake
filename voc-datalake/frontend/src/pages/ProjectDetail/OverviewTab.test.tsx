import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OverviewTab from './OverviewTab'
import type { Project, ProjectPersona, ProjectDocument, ProjectJob } from '../../api/client'

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com/v1' },
  }),
}))

const mockProject: Project = {
  project_id: 'proj-1',
  name: 'Test Project',
  description: 'A test project',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const defaultProps = {
  project: mockProject,
  personas: [] as ProjectPersona[],
  documents: [] as ProjectDocument[],
  jobs: [] as ProjectJob[],
  onGeneratePersonas: vi.fn(),
  onGenerateDoc: vi.fn(),
  onRunResearch: vi.fn(),
  onRemixDocuments: vi.fn(),
  onDismissJob: vi.fn(),
  onSaveKiroPrompt: vi.fn(),
}

describe('OverviewTab', () => {
  it('renders Generate Personas action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Generate Personas')).toBeInTheDocument()
    expect(screen.getByText('Create user personas from feedback')).toBeInTheDocument()
  })

  it('renders Generate PRD / PR-FAQ action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Generate PRD / PR-FAQ')).toBeInTheDocument()
  })

  it('renders Run Research action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Deep dive into feedback with filters')).toBeInTheDocument()
  })

  it('renders Remix Documents action card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Remix Documents')).toBeInTheDocument()
  })

  it('calls onGeneratePersonas when Generate button is clicked', async () => {
    const user = userEvent.setup()
    const onGeneratePersonas = vi.fn()
    render(<OverviewTab {...defaultProps} onGeneratePersonas={onGeneratePersonas} />)
    
    const buttons = screen.getAllByRole('button', { name: /Generate/i })
    await user.click(buttons[0])
    expect(onGeneratePersonas).toHaveBeenCalledTimes(1)
  })

  it('calls onRunResearch when Run Research button is clicked', async () => {
    const user = userEvent.setup()
    const onRunResearch = vi.fn()
    render(<OverviewTab {...defaultProps} onRunResearch={onRunResearch} />)
    
    await user.click(screen.getByRole('button', { name: /Run Research/i }))
    expect(onRunResearch).toHaveBeenCalledTimes(1)
  })

  it('disables Remix Documents when less than 2 documents', () => {
    render(<OverviewTab {...defaultProps} documents={[]} />)
    const remixButton = screen.getByRole('button', { name: /Remix/i })
    expect(remixButton).toBeDisabled()
  })

  it('shows disabled message for Remix Documents', () => {
    render(<OverviewTab {...defaultProps} documents={[]} />)
    expect(screen.getByText('Need at least 2 documents')).toBeInTheDocument()
  })

  it('enables Remix Documents when 2+ documents exist', () => {
    const docs: ProjectDocument[] = [
      { document_id: '1', title: 'Doc 1', content: 'Content 1', doc_type: 'prd', created_at: '' },
      { document_id: '2', title: 'Doc 2', content: 'Content 2', doc_type: 'prd', created_at: '' },
    ]
    render(<OverviewTab {...defaultProps} documents={docs} />)
    const remixButton = screen.getByRole('button', { name: /Remix/i })
    expect(remixButton).not.toBeDisabled()
  })

  it('renders Kiro Export Settings card', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText('Kiro Export Settings')).toBeInTheDocument()
  })

  it('shows empty state when no export prompt configured', () => {
    render(<OverviewTab {...defaultProps} />)
    expect(screen.getByText(/No Kiro export prompt configured/)).toBeInTheDocument()
  })
})
