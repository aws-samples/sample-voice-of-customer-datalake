/**
 * @fileoverview Tests for the scrapers API boundary (issue #167).
 *
 * ScraperConfig declares base_url as a required string, but runtime
 * payloads have delivered scrapers without it. getScrapers normalizes on
 * entry so the declared contract is true for every consumer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./client', () => ({ fetchApi: vi.fn() }))

import { fetchApi } from './client'
import { scrapersApi } from './scrapersApi'
import { at } from '@test/defined'

const mockFetchApi = vi.mocked(fetchApi)

describe('scrapersApi.getScrapers base_url normalization', () => {
  beforeEach(() => {
    mockFetchApi.mockReset()
  })

  it('fills a missing base_url with an empty string', async () => {
    mockFetchApi.mockResolvedValue({
      scrapers: [
        { id: 's-1', name: 'No URL yet' },
        { id: 's-2', name: 'Configured', base_url: 'https://example.com/reviews' },
      ],
    })

    const { scrapers } = await scrapersApi.getScrapers()

    expect(at(scrapers, 0).base_url).toBe('')
    expect(at(scrapers, 1).base_url).toBe('https://example.com/reviews')
  })

  it('tolerates a payload without a scrapers array', async () => {
    mockFetchApi.mockResolvedValue({})

    const { scrapers } = await scrapersApi.getScrapers()

    expect(scrapers).toStrictEqual([])
  })

  it('defaults a missing frequency so the card can never render undefinedm (issue #169)', async () => {
    mockFetchApi.mockResolvedValue({ scrapers: [{ id: 's-1', name: 'Sparse', enabled: false }] })

    const { scrapers } = await scrapersApi.getScrapers()

    expect(at(scrapers, 0).frequency_minutes).toBe(0)
    expect(at(scrapers, 0).urls).toStrictEqual([])
    expect(at(scrapers, 0).pagination.enabled).toBe(false)
  })
})

describe('scrapersApi.getScraperStatus normalization (issue #169)', () => {
  beforeEach(() => {
    mockFetchApi.mockReset()
  })

  it('degrades the drifted status shape to safe counts instead of blanks', async () => {
    // What the mock server historically returned: items_scraped (not
    // items_found), no pages_scraped, errors as a number.
    mockFetchApi.mockResolvedValue({ id: 's-1', status: 'success', items_scraped: 12, errors: 0 })

    const status = await scrapersApi.getScraperStatus('s-1')

    expect(status.pages_scraped).toBe(0)
    expect(status.items_found).toBe(0)
    expect(status.errors).toStrictEqual([])
  })
})

describe('scrapersApi: an upload\'s redaction_unavailable (7.71.04)', () => {
  beforeEach(() => {
    mockFetchApi.mockReset()
  })

  it('reads the rows a paste, a JSON and a CSV upload left out for their redaction, a malformed row dropped', async () => {
    mockFetchApi.mockResolvedValue({ success: true, imported_count: 1, total_items: 3, total_rows: 3, redaction_unavailable: { count: 2, rows: [2, 'x', 0, 3] } })
    const left = { count: 2, rows: [2, 3] }
    expect((await scrapersApi.confirmManualImport('job-1', [])).redaction_unavailable).toStrictEqual(left)
    expect((await scrapersApi.uploadJsonFeedback([])).redaction_unavailable).toStrictEqual(left)
    expect((await scrapersApi.uploadCsvFeedback({ csv_text: 'text\nhi\n' })).redaction_unavailable).toStrictEqual(left)
  })

  it('reads none when the upload left nothing out, or the field is not one', async () => {
    mockFetchApi.mockResolvedValueOnce({ success: true, imported_count: 1, total_items: 1 })
    mockFetchApi.mockResolvedValueOnce({ success: true, imported_count: 1, total_rows: 1, redaction_unavailable: { rows: [2] } })
    expect((await scrapersApi.uploadJsonFeedback([])).redaction_unavailable).toBeUndefined()
    expect((await scrapersApi.uploadCsvFeedback({ csv_text: 'text\nhi\n' })).redaction_unavailable).toBeUndefined()
  })
})
