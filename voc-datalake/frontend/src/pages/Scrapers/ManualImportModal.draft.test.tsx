/**
 * The manual-import draft (live finding): a stale draft over the limit reopened
 * from localStorage on every visit, already refused, with no way to start over.
 * It is now dropped on open with a message, and "Clear draft" starts over.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ManualImportModal from './ManualImportModal'
import { MANUAL_IMPORT_MAX_CHARACTERS, useManualImportStore } from '../../store/manualImportStore'

vi.mock('../../api/scrapersApi', () => ({ scrapersApi: {} }))
vi.mock('../../api/invalidateFeedbackData', () => ({ useInvalidateFeedbackData: () => vi.fn() }))

const URL = 'https://shop.example.com/reviews'

beforeEach(() => {
  useManualImportStore.getState().clearDraft()
  useManualImportStore.setState({ isModalOpen: false, step: 'input' })
})

describe('ManualImportModal draft', () => {
  it('drops a stored draft over the limit when it opens, and says so', () => {
    useManualImportStore.setState({ sourceUrl: URL, rawText: 'x'.repeat(MANUAL_IMPORT_MAX_CHARACTERS + 1) })
    useManualImportStore.getState().setIsModalOpen(true)
    render(<ManualImportModal />)

    expect(screen.getByRole('status')).toHaveTextContent('was longer than 10,000 characters, so it was cleared')
    expect(useManualImportStore.getState()).toMatchObject({ rawText: '', sourceUrl: '' })
  })

  it('keeps a draft within the limit', () => {
    useManualImportStore.setState({ sourceUrl: URL, rawText: 'Great shop', isModalOpen: true })
    render(<ManualImportModal />)

    expect(screen.getByDisplayValue('Great shop')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('clears the draft with "Clear draft", which only shows while there is one', async () => {
    const user = userEvent.setup()
    useManualImportStore.setState({ sourceUrl: URL, rawText: 'Great shop', isModalOpen: true })
    render(<ManualImportModal />)

    await user.click(screen.getByRole('button', { name: 'Clear draft' }))

    expect(useManualImportStore.getState().rawText).toBe('')
    expect(screen.queryByRole('button', { name: 'Clear draft' })).not.toBeInTheDocument()
  })
})
