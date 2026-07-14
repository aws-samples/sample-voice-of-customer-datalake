/**
 * @fileoverview Tests for ScraperEditor — auto-detect visibility (issue #18).
 *
 * Auto-detect discovers CSS selectors; JSON-LD scrapers take their extraction
 * config from the structured data itself, so the button must not appear there
 * and suggest an extra required step. The extraction method is fixed by the
 * template chosen before the editor opens (there is no in-editor switch), so
 * the "create scraper from JSON-LD" flow from the issue is covered via the
 * template prop.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ScraperEditor from './ScraperEditor'
import { DEFAULT_SCRAPER } from './constants'
import enScrapers from '../../../public/locales/en/scrapers.json'
import type { ScraperConfig, ScraperTemplate } from '../../api/types'

vi.mock('../../api/scrapersApi', () => ({
  scrapersApi: {
    analyzeUrlForSelectors: vi.fn(),
  },
}))

// Match on the shipped translation strings so a fallback to raw keys
// ("editor.autoDetect") fails loudly instead of passing by accident.
const AUTO_DETECT_LABEL = enScrapers.editor.autoDetect
const AUTO_DETECT_HINT = enScrapers.editor.autoDetectHint

function makeScraper(overrides: Partial<ScraperConfig>): ScraperConfig {
  return {
    ...DEFAULT_SCRAPER,
    id: 's-1',
    name: 'Test scraper',
    base_url: 'https://example.com/reviews',
    ...overrides,
  }
}

function renderEditor(scraper: ScraperConfig | null, template?: ScraperTemplate) {
  return render(
    <ScraperEditor scraper={scraper} template={template} onSave={vi.fn()} onClose={vi.fn()} />
  )
}

describe('ScraperEditor auto-detect visibility', () => {
  it('shows the auto-detect button and hint for CSS scrapers', () => {
    renderEditor(makeScraper({ extraction_method: 'css' }))

    expect(screen.getByRole('button', { name: AUTO_DETECT_LABEL })).toBeInTheDocument()
    expect(screen.getByText(AUTO_DETECT_HINT)).toBeInTheDocument()
  })

  it('hides the auto-detect button and hint for JSON-LD scrapers', () => {
    renderEditor(makeScraper({ extraction_method: 'jsonld' }))

    expect(screen.queryByRole('button', { name: AUTO_DETECT_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByText(AUTO_DETECT_HINT)).not.toBeInTheDocument()
  })

  it('hides auto-detect when creating a new scraper from a JSON-LD template', () => {
    // The user flow from issue #18: "create scraper from LD Json" — the
    // template fixes the extraction method before the editor opens.
    const jsonLdTemplate: ScraperTemplate = {
      id: 'generic-jsonld',
      name: 'Generic (JSON-LD)',
      description: 'Structured data scraper',
      icon: '🧩',
      extraction_method: 'jsonld',
      url_pattern: 'example.com',
      url_placeholder: 'https://example.com/reviews',
      supports_pagination: true,
      pagination: DEFAULT_SCRAPER.pagination,
      config: {},
    }

    renderEditor(null, jsonLdTemplate)

    expect(screen.queryByRole('button', { name: AUTO_DETECT_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByText(AUTO_DETECT_HINT)).not.toBeInTheDocument()
  })

  it('shows auto-detect when creating a new scraper without a template (CSS default)', () => {
    renderEditor(null)

    expect(screen.getByRole('button', { name: AUTO_DETECT_LABEL })).toBeInTheDocument()
  })
})
