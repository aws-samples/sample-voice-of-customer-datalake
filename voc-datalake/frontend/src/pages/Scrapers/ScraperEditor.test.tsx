/**
 * @fileoverview Tests for ScraperEditor — auto-detect visibility (issue #18).
 *
 * Auto-detect discovers CSS selectors; JSON-LD scrapers take their extraction
 * config from the structured data itself, so the button must not appear there
 * and suggest an extra required step.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ScraperEditor from './ScraperEditor'
import { DEFAULT_SCRAPER_CONFIG } from './constants'
import type { ScraperConfig } from '../../api/types'

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    analyzeUrlForSelectors: vi.fn(),
  },
}))

function makeScraper(overrides: Partial<ScraperConfig>): ScraperConfig {
  return {
    ...DEFAULT_SCRAPER_CONFIG,
    id: 's-1',
    name: 'Test scraper',
    base_url: 'https://example.com/reviews',
    ...overrides,
  }
}

function renderEditor(scraper: ScraperConfig) {
  return render(
    <ScraperEditor scraper={scraper} onSave={vi.fn()} onClose={vi.fn()} />
  )
}

describe('ScraperEditor auto-detect visibility', () => {
  it('shows the auto-detect button for CSS scrapers', () => {
    renderEditor(makeScraper({ extraction_method: 'css' }))

    expect(screen.getByRole('button', { name: /auto-detect/i })).toBeInTheDocument()
  })

  it('hides the auto-detect button and hint for JSON-LD scrapers', () => {
    renderEditor(makeScraper({ extraction_method: 'jsonld' }))

    expect(screen.queryByRole('button', { name: /auto-detect/i })).not.toBeInTheDocument()
  })
})
