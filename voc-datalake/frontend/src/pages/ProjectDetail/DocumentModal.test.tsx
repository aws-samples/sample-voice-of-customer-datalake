import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentModal from './DocumentModal'

describe('DocumentModal', () => {
  const defaultProps = {
    isEditing: false,
    title: '',
    content: '',
    isSaving: false,
    onTitleChange: vi.fn(),
    onContentChange: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
  }

  it('renders Create Document header when not editing', () => {
    render(<DocumentModal {...defaultProps} />)
    expect(screen.getByText('Create Document')).toBeInTheDocument()
  })

  it('renders Edit Document header when editing', () => {
    render(<DocumentModal {...defaultProps} isEditing={true} />)
    expect(screen.getByText('Edit Document')).toBeInTheDocument()
  })

  it('renders title input with value', () => {
    render(<DocumentModal {...defaultProps} title="My Title" />)
    expect(screen.getByPlaceholderText('Document title...')).toHaveValue('My Title')
  })

  it('renders content textarea with value', () => {
    render(<DocumentModal {...defaultProps} content="My content" />)
    expect(screen.getByPlaceholderText(/Write your document/)).toHaveValue('My content')
  })

  it('calls onTitleChange when title input changes', async () => {
    const user = userEvent.setup()
    const onTitleChange = vi.fn()
    render(<DocumentModal {...defaultProps} onTitleChange={onTitleChange} />)
    
    await user.type(screen.getByPlaceholderText('Document title...'), 'New')
    expect(onTitleChange).toHaveBeenCalled()
  })

  it('calls onContentChange when content textarea changes', async () => {
    const user = userEvent.setup()
    const onContentChange = vi.fn()
    render(<DocumentModal {...defaultProps} onContentChange={onContentChange} />)
    
    await user.type(screen.getByPlaceholderText(/Write your document/), 'Text')
    expect(onContentChange).toHaveBeenCalled()
  })

  it('calls onClose when Cancel button is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DocumentModal {...defaultProps} onClose={onClose} />)
    
    await user.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when X button is clicked', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DocumentModal {...defaultProps} onClose={onClose} />)
    
    const buttons = screen.getAllByRole('button')
    await user.click(buttons[0]) // X button is first
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disables save button when title is empty', () => {
    render(<DocumentModal {...defaultProps} title="" content="Some content" />)
    expect(screen.getByRole('button', { name: /Create/i })).toBeDisabled()
  })

  it('disables save button when content is empty', () => {
    render(<DocumentModal {...defaultProps} title="Title" content="" />)
    expect(screen.getByRole('button', { name: /Create/i })).toBeDisabled()
  })

  it('enables save button when both title and content are provided', () => {
    render(<DocumentModal {...defaultProps} title="Title" content="Content" />)
    expect(screen.getByRole('button', { name: /Create/i })).not.toBeDisabled()
  })

  it('shows saving state when isSaving is true', () => {
    render(<DocumentModal {...defaultProps} title="T" content="C" isSaving={true} />)
    expect(screen.getByText('Creating...')).toBeInTheDocument()
  })

  it('shows Saving... when editing and isSaving', () => {
    render(<DocumentModal {...defaultProps} isEditing={true} title="T" content="C" isSaving={true} />)
    expect(screen.getByText('Saving...')).toBeInTheDocument()
  })

  it('renders preview when content is provided', () => {
    render(<DocumentModal {...defaultProps} content="# Heading" />)
    expect(screen.getByText('Preview')).toBeInTheDocument()
  })

  it('does not render preview when content is empty', () => {
    render(<DocumentModal {...defaultProps} content="" />)
    expect(screen.queryByText('Preview')).not.toBeInTheDocument()
  })

  it('calls onSave when save button is clicked', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<DocumentModal {...defaultProps} title="Title" content="Content" onSave={onSave} />)
    
    await user.click(screen.getByRole('button', { name: /Create/i }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
