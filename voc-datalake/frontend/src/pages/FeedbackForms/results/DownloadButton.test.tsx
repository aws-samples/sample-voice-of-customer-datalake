/**
 * Results' Download (7.61.00): the familiar CSV under the view's filters by default, named
 * `<form-name-slug>-responses-<yyyy-mm-dd>.csv` (or as the answer names it), and from its menu the detailed layout or
 * the familiar one with a row of ids; a failed download says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const downloadResponsesCsv = vi.fn<(...args: unknown[]) => Promise<{ blob: Blob; filename: string | null }>>()

vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) =>
  (await import('../test/formsApiMock')).formsApiWith(importOriginal, { downloadResponsesCsv: (...args: unknown[]) => downloadResponsesCsv(...args) }))

import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import DownloadButton from './DownloadButton'

const FILTERS: ResultsFilters = { days: 7, language: 'pl', ending: '', hidden: { event: 'Lisbon' }, includeTest: false }

describe('DownloadButton', () => {
  const saved: string[] = []
  beforeEach(() => {
    vi.clearAllMocks()
    saved.length = 0
    downloadResponsesCsv.mockResolvedValue({ blob: new Blob(['Submission ID']), filename: null })
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:csv'), configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    // (jsdom cannot follow a download link: the file name it would save is kept instead)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download) })
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-20T23:30:00Z') })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('downloads the familiar CSV under the filters, named after the form and the day in UTC', async () => {
    renderWithDraft(<DownloadButton formId="f_test" filters={FILTERS} />, sampleForm({ name: 'Warsztat: Łódź & Lisboa' }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toStrictEqual(['warsztat-lodz-lisboa-responses-2026-11-20.csv']))
    expect(downloadResponsesCsv).toHaveBeenCalledWith('f_test', FILTERS, { layout: 'familiar', ids: false })
  })

  it('offers the detailed layout for scripts and the familiar one with a row of ids', async () => {
    const user = userEvent.setup()
    renderWithDraft(<DownloadButton formId="f_test" filters={FILTERS} />, sampleForm({ name: '' }))
    await user.click(screen.getByRole('button', { name: 'More download options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Detailed CSV (for scripts)' }))
    await user.click(screen.getByRole('button', { name: 'More download options' }))
    await user.click(screen.getByRole('menuitem', { name: 'CSV with a row of ids' }))
    await waitFor(() => expect(downloadResponsesCsv.mock.calls.map((call) => call[2]))
      .toStrictEqual([{ layout: 'detailed', ids: false }, { layout: 'familiar', ids: true }]))
    expect(saved).toStrictEqual(['f_test-responses-2026-11-20-detailed.csv', 'f_test-responses-2026-11-20.csv'])
  })

  it('keeps the name the answer gives, and says when the download failed', async () => {
    const user = userEvent.setup()
    downloadResponsesCsv.mockResolvedValueOnce({ blob: new Blob(['x']), filename: 'named-by-server.csv' }).mockRejectedValueOnce(new Error('offline'))
    renderWithDraft(<DownloadButton formId="f_test" filters={FILTERS} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toStrictEqual(['named-by-server.csv']))
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't export the responses.")
  })
})
