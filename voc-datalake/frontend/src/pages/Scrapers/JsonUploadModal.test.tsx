/**
 * @fileoverview JsonUploadModal: an invalid item is listed (1-based, plain reason) and
 * skipped, and Import sends only the valid items. The server still validates each one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { renderWithQueryClient } from '@test/query-client'
import JsonUploadModal from './JsonUploadModal'

const mockUploadJson = vi.fn<(items: unknown[]) => Promise<unknown>>()

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: { uploadJsonFeedback: (items: unknown[]) => mockUploadJson(items) },
}))
const mockAfterIngest = vi.fn()
vi.mock('../../api/invalidateFeedbackData', () => ({ useInvalidateFeedbackData: () => mockAfterIngest }))

const T = (key: string, opts?: Record<string, unknown>) => i18n.t(`jsonUpload.${key}`, { ns: 'scrapers', ...opts })
const good = { id: 'a', text: 'Great', source: 'zendesk', timestamp: '2026-03-20T14:30:00Z' }
const noText = { id: 'b', source: 'zendesk', timestamp: '2026-03-20T14:30:00Z' }

async function pick(items: unknown[]) {
  const user = userEvent.setup()
  renderWithQueryClient(<JsonUploadModal isOpen onClose={vi.fn()} />)
  const input = document.querySelector('input[type="file"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found')
  await user.upload(input, new File([JSON.stringify(items)], 'feedback.json', { type: 'application/json' }))
  return user
}

const importButton = (count: number) => screen.findByRole('button', { name: T('importItems', { count, plural: count === 1 ? '' : 's' }) })

describe('JsonUploadModal with an invalid item', () => {
  beforeEach(() => {
    mockUploadJson.mockReset()
    mockAfterIngest.mockReset()
    mockUploadJson.mockResolvedValue({ success: true, imported_count: 1 })
  })

  it('names the invalid item by its 1-based position with a plain reason', async () => {
    await pick([good, noText])

    const expected = T('skippedItem', { position: 2, reasons: T('reasonRequired', { field: 'text' }) })
    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.getByText(T('skippedTitle', { count: 1 }))).toBeInTheDocument()
  })

  it('keeps Import enabled for the valid items and sends only those', async () => {
    const user = await pick([good, noText])

    const button = await importButton(1)
    expect(button).toBeEnabled()
    await user.click(button)
    expect(mockUploadJson).toHaveBeenCalledWith([good])
    await waitFor(() => { expect(mockAfterIngest).toHaveBeenCalledExactlyOnceWith({ afterIngest: true }) })
  })

  it('the control: a clean file shows no skipped notice', async () => {
    await pick([good])

    expect(await importButton(1)).toBeEnabled()
    expect(screen.queryByText(T('skippedTitle', { count: 1 }))).not.toBeInTheDocument()
  })
})
