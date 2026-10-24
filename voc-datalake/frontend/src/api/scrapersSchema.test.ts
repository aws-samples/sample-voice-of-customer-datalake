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
import { at } from '@test/defined'

const sparseScraper = { id: 'scraper_2', name: 'Forum Posts', enabled: false }

describe('normalizeScrapers (issue #169)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fills every missing field on a sparse legacy record with conservative defaults', () => {
    const scraper = at(normalizeScrapers([sparseScraper]), 0)

    expect(scraper).toMatchObject({
      base_url: '',
      urls: [],
      // 0 = 'Manual only': the truthful schedule for a record that has none.
      // Anything nonzero would claim runs that never happen; undefined was
      // the 'undefinedm' symptom.
      frequency_minutes: 0,
      container_selector: '',
      text_selector: '',
    })
    expect(scraper.pagination).toStrictEqual({ enabled: false, param: 'page', max_pages: 1, start: 1 })
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

    const scraper = at(normalizeScrapers([configured]), 0)

    expect(scraper).toMatchObject(configured)
  })

  it('treats explicit nulls like missing fields (DynamoDB emits both)', () => {
    const scraper = at(normalizeScrapers([
      { ...sparseScraper, base_url: null, frequency_minutes: null, urls: null, pagination: null },
    ]), 0)

    expect(scraper.base_url).toBe('')
    expect(scraper.frequency_minutes).toBe(0)
    expect(scraper.urls).toStrictEqual([])
    expect(scraper.pagination).toStrictEqual({ enabled: false, param: 'page', max_pages: 1, start: 1 })
  })

  it('coerces numeric-string round-trips and merges partial pagination', () => {
    const scraper = at(normalizeScrapers([
      { ...sparseScraper, frequency_minutes: '30', pagination: { enabled: true, max_pages: '5' } },
    ]), 0)

    expect(scraper.frequency_minutes).toBe(30)
    expect(scraper.pagination).toStrictEqual({ enabled: true, param: 'page', max_pages: 5, start: 1 })
  })

  it('salvages string urls and drops junk elements instead of discarding the array', () => {
    const scraper = at(normalizeScrapers([
      { ...sparseScraper, urls: ['https://a.example.com', 42, null, 'https://b.example.com'] },
    ]), 0)

    expect(scraper.urls).toStrictEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('drops records without a usable id instead of inventing one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const scrapers = normalizeScrapers([
      sparseScraper,
      { name: 'No Identity', enabled: true },
      { id: '', name: 'Empty Identity', enabled: true },
    ])

    expect(scrapers.map((s) => s.id)).toStrictEqual(['scraper_2'])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('passes unknown backend fields through so edit round-trips lose nothing', () => {
    const scraper = at(normalizeScrapers([
      { ...sparseScraper, created_at: '2026-01-01T00:00:00Z', future_field: { nested: true } },
    ]), 0)

    // A record read from getScrapers() and saved back by the editor must
    // not silently shed fields this schema doesn't enumerate.
    expect(scraper).toMatchObject({
      created_at: '2026-01-01T00:00:00Z',
      future_field: { nested: true },
    })
  })
})

describe('normalizeScraperRunStatus (issue #169)', () => {
  it('degrades missing counts to 0 so the summary never renders blank counts', () => {
    // The drifted mock shape: items_scraped instead of items_found, no
    // pages_scraped, errors as a number — rendered 'Last: pages, reviews'.
    const status = normalizeScraperRunStatus({ id: 'scraper_1', status: 'success', items_scraped: 12, errors: 0 })

    expect(status.pages_scraped).toBe(0)
    expect(status.items_found).toBe(0)
    expect(status.errors).toStrictEqual([])
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

  it('degrades even a non-object response to never_run instead of throwing', () => {
    // Error bodies and empty responses must not throw out of the polling
    // path — same degrade-don't-reject philosophy as the fields.
    for (const garbage of [null, undefined, 'Internal Server Error', 42]) {
      const status = normalizeScraperRunStatus(garbage)
      expect(status.status).toBe('never_run')
      expect(status.pages_scraped).toBe(0)
      expect(status.errors).toStrictEqual([])
    }
  })

  it('keeps string errors and drops junk elements', () => {
    const status = normalizeScraperRunStatus({ status: 'error', errors: ['timeout', 500, null] })

    expect(status.errors).toStrictEqual(['timeout'])
  })

  it('coerces numeric-string counts', () => {
    const status = normalizeScraperRunStatus({ status: 'completed', pages_scraped: '3', items_found: '42' })

    expect(status.pages_scraped).toBe(3)
    expect(status.items_found).toBe(42)
  })
})
