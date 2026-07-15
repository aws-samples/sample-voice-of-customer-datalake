/**
 * @fileoverview Tests for ScraperCard — invalid base_url resilience (issue #167).
 *
 * A render-time `new URL(...)` TypeError on a missing or malformed base_url
 * crashed the entire /scrapers route. The card must render for every value
 * runtime data has been observed to carry: undefined (mock server, older
 * configs), empty/whitespace, scheme-less, and garbage.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import ScraperCard, { scraperDomainLabel } from './ScraperCard'
import { DEFAULT_SCRAPER } from './constants'
import type { ScraperConfig } from '../../api/types'

vi.mock('../../api/scrapersApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/scrapersApi')>()
  // Full-surface stub (same pattern as ScraperEditor.test.tsx): future API
  // calls hit an assertable vi.fn(), not an opaque "not a function".
  const stubs = Object.fromEntries(
    Object.keys(actual.scrapersApi).map((name) => [name, vi.fn().mockResolvedValue({ status: 'never_run' })]),
  )
  return { scrapersApi: stubs }
})

const NOT_CONFIGURED = i18n.t('card.notConfigured', { ns: 'scrapers' })

function makeScraper(overrides: Partial<ScraperConfig>): ScraperConfig {
  return {
    ...DEFAULT_SCRAPER,
    id: 's-1',
    name: 'Test scraper',
    ...overrides,
  }
}

function renderCard(scraper: ScraperConfig) {
  return render(
    <ScraperCard scraper={scraper} onEdit={vi.fn()} onDelete={vi.fn()} onRun={vi.fn()} />
  )
}

describe('scraperDomainLabel', () => {
  it('resolves the hostname for a valid URL', () => {
    expect(scraperDomainLabel('https://shop.example.com/reviews?page=1', NOT_CONFIGURED))
      .toBe('shop.example.com')
  })

  it('treats undefined, empty, and whitespace as not configured', () => {
    expect(scraperDomainLabel(undefined, NOT_CONFIGURED)).toBe(NOT_CONFIGURED)
    expect(scraperDomainLabel('', NOT_CONFIGURED)).toBe(NOT_CONFIGURED)
    expect(scraperDomainLabel('   ', NOT_CONFIGURED)).toBe(NOT_CONFIGURED)
  })

  it('falls back to the raw value for unparseable URLs instead of throwing', () => {
    expect(scraperDomainLabel('example.com', NOT_CONFIGURED)).toBe('example.com')
    expect(scraperDomainLabel('not a url at all', NOT_CONFIGURED)).toBe('not a url at all')
  })
})

describe('ScraperCard base_url resilience (issue #167)', () => {
  it('renders a scheme-less base_url instead of crashing the route', () => {
    // Type-legal value that previously threw `TypeError: Invalid URL`
    // during render and killed the whole /scrapers page.
    renderCard(makeScraper({ base_url: 'example.com' }))

    expect(screen.getByText('Test scraper')).toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
  })

  it('shows not-configured and disables Run for an empty base_url', () => {
    renderCard(makeScraper({ base_url: '' }))

    expect(screen.getByText(NOT_CONFIGURED)).toBeInTheDocument()
    expect(screen.getByTitle(i18n.t('card.runNow', { ns: 'scrapers' }))).toBeDisabled()
  })

  it('renders normally for a valid base_url', () => {
    renderCard(makeScraper({ base_url: 'https://shop.example.com/reviews' }))

    expect(screen.getByText('shop.example.com')).toBeInTheDocument()
    expect(screen.getByTitle(i18n.t('card.runNow', { ns: 'scrapers' }))).not.toBeDisabled()
  })
})
