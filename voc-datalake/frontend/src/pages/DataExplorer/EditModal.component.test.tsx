/**
 * The Data Explorer editor saves the record as it was opened, `updated_at` included: the API compares that
 * stamp with the stored one (`PUT /data-explorer/feedback`, 409 when someone else changed the record since).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditModal from './EditModal'

const RECORD = { feedback_id: 'f1', source_platform: 'web', urgency: 'high', updated_at: '2026-11-01T00:00:00+00:00' }

describe('EditModal on a processed record', () => {
  it('saves the record with the updated_at it was opened with', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<EditModal isOpen mode="edit" type="dynamodb" data={RECORD} feedbackId="f1" onClose={vi.fn()}
      onSave={onSave} saving={false} />)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ updated_at: RECORD.updated_at }), false)
  })
})
