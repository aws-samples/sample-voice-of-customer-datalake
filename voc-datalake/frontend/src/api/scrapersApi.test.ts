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
