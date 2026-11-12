import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DocumentModal from './DocumentModal'
import { DocumentModalWrapper } from './ProjectModals'
import { required } from '../../components/component-spec-fixtures'

/** The editor props both the dialog and its wrapper take: an empty, idle form. */
const defaultProps = {
  title: '',
  content: '',
  isSaving: false,
  onTitleChange: vi.fn(),
  onContentChange: vi.fn(),
  onSave: vi.fn(),
  onClose: vi.fn(),
}

describe('DocumentModal', () => {

  it('renders Create Document header', () => {
    render(<DocumentModal {...defaultProps} />)
    expect(screen.getByText('Create Document')).toBeInTheDocument()
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
    render(<DocumentModal {...defaultProps} title="Saved title" content="Saved body" onClose={onClose} />)
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

describe('DocumentModalWrapper', () => {
  it('renders nothing while the New document dialog is closed', () => {
    const { container } = render(<DocumentModalWrapper showModal={false} {...defaultProps} />)
    expect(container).toBeEmptyDOMElement()
  })

  // Create only: an existing document is edited in place on its canvas, never in this dialog.
  it('opens the create dialog with an editable title', () => {
    render(<DocumentModalWrapper showModal {...defaultProps} title="Notes" />)
    expect(screen.getByRole('dialog', { name: 'Create Document' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Document title...')).toBeEnabled()
    expect(screen.queryByText('Edit Document')).not.toBeInTheDocument()
  })
})
