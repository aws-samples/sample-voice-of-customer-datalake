import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AutoseedCard from './AutoseedCard'
import type { ProjectPersona, ProjectDocument } from '../../api/types'

vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com/v1' },
  }),
}))

const mockPersonas: ProjectPersona[] = [
  { persona_id: 'p1', name: 'Alice', tagline: 'Power user', created_at: '' },
  { persona_id: 'p2', name: 'Bob', tagline: 'Casual browser', created_at: '' },
]

const mockDocuments: ProjectDocument[] = [
  { document_id: 'd1', title: 'Feature PRD', content: '', document_type: 'prd', created_at: '' },
  { document_id: 'd2', title: 'Launch PR/FAQ', content: '', document_type: 'prfaq', created_at: '' },
  { document_id: 'd3', title: 'User Research', content: '', document_type: 'research', created_at: '' },
]

const defaultProps = {
  projectId: 'proj-1',
  personas: mockPersonas,
  documents: mockDocuments,
}

describe('AutoseedCard', () => {
  const writeTextMock = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    writeTextMock.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    })
  })

  it('renders the card title', () => {
    render(<AutoseedCard {...defaultProps} />)
    expect(screen.getByText('Kiro Autoseed')).toBeInTheDocument()
  })

  it('shows empty state when no personas or documents', () => {
    render(<AutoseedCard projectId="proj-1" personas={[]} documents={[]} />)
    expect(screen.getByText(/Generate personas or documents first/)).toBeInTheDocument()
  })

  it('renders persona checkboxes', () => {
    render(<AutoseedCard {...defaultProps} />)
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
  })

  it('renders document checkboxes grouped by type', () => {
    render(<AutoseedCard {...defaultProps} />)
    expect(screen.getByText('Feature PRD')).toBeInTheDocument()
    expect(screen.getByText('Launch PR/FAQ')).toBeInTheDocument()
    expect(screen.getByText('User Research')).toBeInTheDocument()
  })

  it('renders document type group labels', () => {
    render(<AutoseedCard {...defaultProps} />)
    expect(screen.getByText('PRDs')).toBeInTheDocument()
    expect(screen.getByText('PR/FAQs')).toBeInTheDocument()
    expect(screen.getByText('Research')).toBeInTheDocument()
  })

  it('all items are selected by default', () => {
    render(<AutoseedCard {...defaultProps} />)
    const checkboxes = screen.getAllByRole('checkbox')
    for (const cb of checkboxes) {
      expect(cb).toBeChecked()
    }
  })

  it('deselects a persona when clicked', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    const aliceCheckbox = screen.getByLabelText(/Alice/)
    await user.click(aliceCheckbox)
    expect(aliceCheckbox).not.toBeChecked()
  })

  it('deselects a document when clicked', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    const prdCheckbox = screen.getByLabelText(/Feature PRD/)
    await user.click(prdCheckbox)
    expect(prdCheckbox).not.toBeChecked()
  })

  it('generates URL without query params when all selected', () => {
    render(<AutoseedCard {...defaultProps} />)
    // All selected = no query params (server returns all by default)
    expect(screen.getByText(/\/projects\/proj-1\/autoseed/)).toBeInTheDocument()
  })

  it('generates URL with persona_ids when some deselected', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    // Deselect Bob
    await user.click(screen.getByLabelText(/Bob/))
    expect(screen.getByText(/persona_ids=p1/)).toBeInTheDocument()
  })

  it('generates URL with document_ids when some deselected', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    // Deselect the PRD
    await user.click(screen.getByLabelText(/Feature PRD/))
    expect(screen.getByText(/document_ids=d2%2Cd3/)).toBeInTheDocument()
  })

  it('copies prompt to clipboard', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    await user.click(screen.getByRole('button', { name: /Copy Kiro Prompt/ }))
    await waitFor(() => {
      expect(screen.getByText('Copied')).toBeInTheDocument()
    })
  })

  it('deselect all personas works', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    const deselectButtons = screen.getAllByText('Deselect all')
    await user.click(deselectButtons[0])
    const checkboxes = screen.getAllByRole('checkbox')
    // First two are personas — should be unchecked
    expect(checkboxes[0]).not.toBeChecked()
    expect(checkboxes[1]).not.toBeChecked()
  })

  it('select all personas works after deselecting', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    // First deselect all personas
    const deselectButtons = screen.getAllByText('Deselect all')
    await user.click(deselectButtons[0])
    // Now click Select all (first one is personas)
    const selectButtons = screen.getAllByText('Select all')
    await user.click(selectButtons[0])
    const aliceCheckbox = screen.getByLabelText(/Alice/)
    expect(aliceCheckbox).toBeChecked()
  })

  it('collapses persona section when header clicked', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    expect(screen.getByText('Alice')).toBeInTheDocument()
    // Click the personas section header
    await user.click(screen.getByText(/Personas \(2\/2\)/))
    expect(screen.queryByText('Alice')).not.toBeInTheDocument()
  })

  it('prompt includes Bearer token placeholder', () => {
    render(<AutoseedCard {...defaultProps} />)
    expect(screen.getByText(/Bearer <YOUR_API_TOKEN>/)).toBeInTheDocument()
  })

  it('prompt mentions MCP Access tab', () => {
    render(<AutoseedCard {...defaultProps} />)
    const matches = screen.getAllByText(/MCP Access tab/)
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  it('disables copy button when nothing selected', async () => {
    const user = userEvent.setup()
    render(<AutoseedCard {...defaultProps} />)
    // Deselect all personas and documents
    const deselectButtons = screen.getAllByText('Deselect all')
    await user.click(deselectButtons[0])
    await user.click(deselectButtons[1])
    const copyButton = screen.getByRole('button', { name: /Copy Kiro Prompt/ })
    expect(copyButton).toBeDisabled()
  })
})
