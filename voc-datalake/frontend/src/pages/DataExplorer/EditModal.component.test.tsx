/**
 * The Data Explorer editor: it saves the record as it was opened (`updated_at` included, which the API compares
 * with the stored one: 409 when someone else changed the record since), refuses invalid JSON, offers the
 * DynamoDB sync only for an S3 file it edits, shows media read-only, and shows the save error.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditModal from './EditModal'

const RECORD = { feedback_id: 'f1', source_platform: 'web', urgency: 'high', updated_at: '2026-11-01T00:00:00+00:00' }

type Props = Parameters<typeof EditModal>[0]

function renderModal(props: Partial<Props> = {}) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(<EditModal isOpen mode="edit" type="dynamodb" data={RECORD} feedbackId="f1" onClose={onClose}
    onSave={onSave} saving={false} {...props} />)
  return { onSave, onClose }
}

describe('EditModal on a processed record', () => {
  it('saves the record with the updated_at it was opened with', async () => {
    const { onSave } = renderModal()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ updated_at: RECORD.updated_at }), false)
  })

  it('refuses invalid JSON: names the error and disables Save', async () => {
    const { onSave } = renderModal()
    const user = userEvent.setup()
    const editor = screen.getByRole('textbox', { name: 'File content' })
    await user.clear(editor)
    await user.type(editor, '{{"broken"')
    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('in view mode offers Close only, and no DynamoDB sync', async () => {
    const { onClose } = renderModal({ mode: 'view' })
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(screen.queryByText('Also update DynamoDB')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Close' }).at(-1) ?? document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the save error', () => {
    renderModal({ error: 'This review was changed by someone else. Reload and retry.' })
    expect(screen.getByRole('alert')).toHaveTextContent('changed by someone else')
  })
})

describe('EditModal on an S3 file', () => {
  it('creates a file and passes the DynamoDB sync choice', async () => {
    const { onSave } = renderModal({ mode: 'create', type: 's3', data: '{"a": 1}', s3Key: 'raw/web/x.json',
      feedbackId: undefined })
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: 'Also update DynamoDB' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSave).toHaveBeenCalledWith({ a: 1 }, true)
  })

  it.each([
    ['an image', 'image/png', 'avatars/p1.png', 'img'],
    ['a PDF', 'application/pdf', 'docs/brief.pdf', 'iframe'],
  ])('shows %s read-only, with no Save', (_case, contentType, s3Key, tag) => {
    const { container } = render(<EditModal isOpen mode="edit" type="s3" data="https://cdn.example.com/x"
      s3Key={s3Key} contentType={contentType} isPresignedUrl onClose={vi.fn()} onSave={vi.fn()} saving={false} />)
    expect(container.ownerDocument.querySelector(tag)).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })
})
