/**
 * Regression tests for issue #169: sparse scraper records rendered
 * 'undefinedm' for frequency, and the drifted status shape rendered the
 * last-run summary with blank counts ('Last: pages, reviews'). The schemas
 * make the declared contracts true at the API boundary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normalizeScrapers, normalizeScraperRunStatus,
} from './scrapersSchema'

const sparseScraper = { id: 'scraper_2', name: 'Forum Posts', enabled: false }

describe('normalizeScrapers (issue #169)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fills every missing field on a sparse legacy record with conservative defaults', () => {
    const [scraper] = normalizeScrapers([sparseScraper])

    expect(scraper.base_url).toBe('')
    expect(scraper.urls).toEqual([])
    // 0 = 'Manual only': the truthful schedule for a record that has none.
    // Anything nonzero would claim runs that never happen; undefined was
    // the 'undefinedm' symptom.
    expect(scraper.frequency_minutes).toBe(0)
    expect(scraper.container_selector).toBe('')
    expect(scraper.text_selector).toBe('')
    expect(scraper.pagination).toEqual({ enabled: false, param: 'page', max_pages: 1, start: 1 })
  })

  it('passes a fully configured record through unchanged', () => {
    const configured = {
      id: 'scraper_1', name: 'Product Reviews', enabled: true,
      base_url: 'https://example.com/reviews', urls: ['https://example.com/reviews?sort=recent'],
      frequency_minutes: 30, extraction_method: 'css',
      container_selector: '.review', text_selector: '.review-text',
      pagination: { enabled: true, param: 'page', max_pages: 3, start: 1 },
      last_run: '2026-07-15T00:00:00Z', items_found: 42,
    }

    const [scraper] = normalizeScrapers([configured])

    expect(scraper).toMatchObject(configured)
  })

  it('treats explicit nulls like missing fields (DynamoDB emits both)', () => {
    const [scraper] = normalizeScrapers([
      { ...sparseScraper, base_url: null, frequency_minutes: null, urls: null, pagination: null },
    ])

    expect(scraper.base_url).toBe('')
    expect(scraper.frequency_minutes).toBe(0)
    expect(scraper.urls).toEqual([])
    expect(scraper.pagination).toEqual({ enabled: false, param: 'page', max_pages: 1, start: 1 })
  })

  it('coerces numeric-string round-trips and merges partial pagination', () => {
    const [scraper] = normalizeScrapers([
      { ...sparseScraper, frequency_minutes: '30', pagination: { enabled: true, max_pages: '5' } },
    ])

    expect(scraper.frequency_minutes).toBe(30)
    expect(scraper.pagination).toEqual({ enabled: true, param: 'page', max_pages: 5, start: 1 })
  })

  it('salvages string urls and drops junk elements instead of discarding the array', () => {
    const [scraper] = normalizeScrapers([
      { ...sparseScraper, urls: ['https://a.example.com', 42, null, 'https://b.example.com'] },
    ])

    expect(scraper.urls).toEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('drops records without a usable id instead of inventing one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const scrapers = normalizeScrapers([
      sparseScraper,
      { name: 'No Identity', enabled: true },
      { id: '', name: 'Empty Identity', enabled: true },
    ])

    expect(scrapers.map((s) => s.id)).toEqual(['scraper_2'])
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('normalizeScraperRunStatus (issue #169)', () => {
  it('degrades missing counts to 0 so the summary never renders blank counts', () => {
    // The drifted mock shape: items_scraped instead of items_found, no
    // pages_scraped, errors as a number — rendered 'Last: pages, reviews'.
    const status = normalizeScraperRunStatus({ id: 'scraper_1', status: 'success', items_scraped: 12, errors: 0 })

    expect(status.pages_scraped).toBe(0)
    expect(status.items_found).toBe(0)
    expect(status.errors).toEqual([])
  })

  it('passes a real run status through unchanged', () => {
    const run = {
      scraper_id: 'scraper_1', status: 'completed',
      started_at: '2026-07-15T00:00:00Z', completed_at: '2026-07-15T00:01:00Z',
      pages_scraped: 3, items_found: 42, errors: [],
    }

    expect(normalizeScraperRunStatus(run)).toMatchObject(run)
  })

  it('defaults a missing status to never_run (nothing-to-show for the card)', () => {
    expect(normalizeScraperRunStatus({}).status).toBe('never_run')
  })

  it('keeps string errors and drops junk elements', () => {
    const status = normalizeScraperRunStatus({ status: 'error', errors: ['timeout', 500, null] })

    expect(status.errors).toEqual(['timeout'])
  })

  it('coerces numeric-string counts', () => {
    const status = normalizeScraperRunStatus({ status: 'completed', pages_scraped: '3', items_found: '42' })

    expect(status.pages_scraped).toBe(3)
    expect(status.items_found).toBe(42)
  })
})
