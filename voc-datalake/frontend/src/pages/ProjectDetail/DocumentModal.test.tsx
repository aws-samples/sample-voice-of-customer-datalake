import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentModal from './DocumentModal'
import { DocumentModalWrapper } from './ProjectModals'
import type { ProjectDocument } from '../../api/types'
import { required } from '../../components/component-spec-fixtures'

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

  it('disables the title input when the title is version-managed', async () => {
    const user = userEvent.setup()
    const onTitleChange = vi.fn()
    render(
      <DocumentModal
        {...defaultProps}
        title="Launch (v2)"
        titleReadOnly={true}
        onTitleChange={onTitleChange}
      />,
    )

    const titleInput = screen.getByPlaceholderText('Document title...')
    expect(titleInput).toBeDisabled()
    await user.type(titleInput, 'Different')
    expect(onTitleChange).not.toHaveBeenCalled()
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
    // A controlled input held at '', so each keystroke reports just that key.
    expect(onTitleChange.mock.calls).toStrictEqual([['N'], ['e'], ['w']])
  })

  it('calls onContentChange when content textarea changes', async () => {
    const user = userEvent.setup()
    const onContentChange = vi.fn()
    render(<DocumentModal {...defaultProps} onContentChange={onContentChange} />)
    
    await user.type(screen.getByPlaceholderText(/Write your document/), 'Text')
    expect(onContentChange.mock.calls).toStrictEqual([['T'], ['e'], ['x'], ['t']])
  })

  it.each([
    ['Cancel button', () => screen.getByText('Cancel')],
    // The X button is the first button the modal renders.
    ['X button', () => required(screen.getAllByRole('button').at(0), 'the X button')],
  ])('calls onClose when the %s is clicked', async (_name, closeButton) => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DocumentModal {...defaultProps} onClose={onClose} />)

    await user.click(closeButton())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Design audit D-OVL: Escape did nothing on an empty Create Document dialog.
  it('closes on Escape while nothing has been written', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DocumentModal {...defaultProps} title="" content="" onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before Escape discards a typed title (unsaved-changes guard, E2E F6)', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { rerender } = render(<DocumentModal {...defaultProps} onClose={onClose} />)
    // The host owns the fields: typing arrives as a new `title` prop.
    rerender(<DocumentModal {...defaultProps} title="Draft" onClose={onClose} />)
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape when nothing changed since it opened', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DocumentModal {...defaultProps} isEditing title="Saved title" content="Saved body" onClose={onClose} />)
    await user.keyboard('{Escape}')
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

describe('DocumentModalWrapper managed titles', () => {
  const managedCases: { name: string; document: ProjectDocument }[] = [
    {
      name: 'current prototype type',
      document: {
        document_id: 'prototype-1',
        document_type: 'prototype',
        title: 'Checkout prototype (v2)',
        content: '<html><body>Checkout</body></html>',
        created_at: '2026-09-02T00:00:00Z',
      },
    },
    {
      name: 'legacy managed sort key',
      document: {
        document_id: 'legacy-1',
        document_type: 'custom',
        sk: 'PROTOTYPE#legacy-1',
        title: 'Legacy prototype (v1)',
        content: 'legacy content',
        created_at: '2026-09-01T00:00:00Z',
      },
    },
  ]

  it.each(managedCases)('keeps the canonical title read-only for $name', ({ document }) => {
    render(
      <DocumentModalWrapper
        showModal={true}
        editingDoc={document}
        title={document.title}
        content={document.content}
        isSaving={false}
        onTitleChange={vi.fn()}
        onContentChange={vi.fn()}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByPlaceholderText('Document title...')).toBeDisabled()
    expect(screen.getByPlaceholderText('Document title...')).toHaveValue(document.title)
  })
})
