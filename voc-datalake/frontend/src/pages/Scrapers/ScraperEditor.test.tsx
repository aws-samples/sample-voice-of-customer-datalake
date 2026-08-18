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
import i18n from 'i18next'
import ScraperEditor from './ScraperEditor'
import { DEFAULT_SCRAPER } from './constants'
import type { ScraperConfig, ScraperTemplate } from '../../api/types'

vi.mock('../../api/scrapersApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/scrapersApi')>()
  // Stub the WHOLE real API surface: a future call from the component hits
  // an assertable vi.fn() instead of an opaque "x is not a function", and
  // newly added methods are covered automatically.
  const stubs = Object.fromEntries(
    Object.keys(actual.scrapersApi).map((name) => [name, vi.fn()]),
  )
  return { scrapersApi: stubs }
})

// Derive the shipped strings from the shared i18n test setup (the single
// owner of locale loading — src/test/setup.ts) instead of coupling this file
// to the locale directory layout.
const AUTO_DETECT_LABEL = i18n.t('editor.autoDetect', { ns: 'scrapers' })
const AUTO_DETECT_HINT = i18n.t('editor.autoDetectHint', { ns: 'scrapers' })

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
  it('resolves the shipped strings from the i18n test setup', () => {
    // Guard against vacuous passes: if the namespace/keys stop resolving,
    // t() returns the raw key — which a broken component would also render,
    // letting every assertion below "agree" on the wrong thing.
    expect(AUTO_DETECT_LABEL).not.toContain('editor.autoDetect')
    expect(AUTO_DETECT_HINT).not.toContain('editor.autoDetectHint')
  })

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

  it('keeps auto-detect for legacy configs without an extraction_method', () => {
    // Configs saved before JSON-LD support predate the field and are CSS
    // scrapers — the positive === check must not hide their button.
    renderEditor(makeScraper({ extraction_method: undefined }))

    expect(screen.getByRole('button', { name: AUTO_DETECT_LABEL })).toBeInTheDocument()
  })
})
