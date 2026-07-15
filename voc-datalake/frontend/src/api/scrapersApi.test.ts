/**
 * @fileoverview Tests for the scrapers API boundary (issue #167).
 *
 * ScraperConfig declares base_url as a required string, but runtime
 * payloads have delivered scrapers without it. getScrapers normalizes on
 * entry so the declared contract is true for every consumer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchApi = vi.fn()

vi.mock('./client', () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}))

import { scrapersApi } from './scrapersApi'

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

    expect(scrapers[0].base_url).toBe('')
    expect(scrapers[1].base_url).toBe('https://example.com/reviews')
  })

  it('tolerates a payload without a scrapers array', async () => {
    mockFetchApi.mockResolvedValue({})

    const { scrapers } = await scrapersApi.getScrapers()

    expect(scrapers).toEqual([])
  })
})
