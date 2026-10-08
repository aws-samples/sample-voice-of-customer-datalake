/**
 * @fileoverview Tests for ScraperEditor.
 *
 * Auto-detect visibility (issue #18): auto-detect discovers CSS selectors;
 * JSON-LD scrapers take their extraction config from the structured data itself,
 * so the button must not appear there and suggest an extra required step. The
 * extraction method is fixed by the template chosen before the editor opens
 * (there is no in-editor switch), so the "create scraper from JSON-LD" flow from
 * the issue is covered via the template prop.
 *
 * Save and the schedule (owner decision, 2026-10-04): `POST /scrapers` is open to
 * every authenticated user, so Save works for both roles, creating and editing.
 * Only the frequency is admin-only — the server keeps a non-admin's schedule — so
 * that one control is disabled for them. Each locked case has an admin positive
 * control, so "disable everything" cannot pass.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient as render } from '@test/query-client'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import {
  buttonWithIcon, makeScraper as makeBaseScraper, scrapersApiStubModule,
} from './scrapers-fixtures'
import ScraperEditor from './ScraperEditor'
// Imported rather than restated: the subject of these assertions is the GATE, not
// the wording. See the constant's own docstring.
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { DEFAULT_SCRAPER } from './constants'
import { at } from '@test/defined'
import type { ScraperConfig, ScraperTemplate } from '../../api/types'

// Stub the WHOLE real API surface — see `scrapersApiStubModule`.
vi.mock('../../api/scrapersApi', async (importOriginal) => scrapersApiStubModule(importOriginal))

// Derive the shipped strings from the shared i18n test setup (the single
// owner of locale loading — src/test/setup.ts) instead of coupling this file
// to the locale directory layout.
const AUTO_DETECT_LABEL = i18n.t('editor.autoDetect', { ns: 'scrapers' })
const AUTO_DETECT_HINT = i18n.t('editor.autoDetectHint', { ns: 'scrapers' })

function makeScraper(overrides: Partial<ScraperConfig>): ScraperConfig {
  return makeBaseScraper({ base_url: 'https://example.com/reviews', ...overrides })
}

function renderEditor(scraper: ScraperConfig | null, template?: ScraperTemplate) {
  return render(
    <ScraperEditor scraper={scraper} template={template} isAdmin onSave={vi.fn()} onClose={vi.fn()} />
  )
}

/** Neither the auto-detect button nor its hint is rendered. */
function expectAutoDetectHidden() {
  expect(screen.queryByRole('button', { name: AUTO_DETECT_LABEL })).not.toBeInTheDocument()
  expect(screen.queryByText(AUTO_DETECT_HINT)).not.toBeInTheDocument()
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

    expectAutoDetectHidden()
  })

  it('hides auto-detect when creating a new scraper from a JSON-LD template', () => {
    // The user flow from issue #18: "create scraper from LD Json" — the
    // template fixes the extraction method before the editor opens.
    const jsonLdTemplate: ScraperTemplate = {
      id: 'generic-jsonld',
      name: 'Generic (JSON-LD)',
      description: 'Structured data scraper',
      icon: 'JSON-LD',
      extraction_method: 'jsonld',
      url_pattern: 'example.com',
      url_placeholder: 'https://example.com/reviews',
      supports_pagination: true,
      pagination: DEFAULT_SCRAPER.pagination,
      config: {},
    }

    renderEditor(null, jsonLdTemplate)

    expectAutoDetectHidden()
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

describe('ScraperEditor save is open, schedule is admin-only', () => {
  /** The Save button, located by its lucide icon rather than by its accessible
   *  name, which changes with the locale. */
  const saveButton = () => buttonWithIcon('lucide-save')
  const frequencySelect = () => screen.getByRole('combobox', { name: i18n.t('editor.frequency', { ns: 'scrapers' }) })

  function renderWith(isAdmin: boolean, scraper: ScraperConfig | null = makeScraper({})) {
    const onSave = vi.fn<(s: ScraperConfig) => Promise<unknown>>(() => Promise.resolve())
    const onClose = vi.fn()
    render(<ScraperEditor scraper={scraper} isAdmin={isAdmin} onSave={onSave} onClose={onClose} />)
    return { onSave, onClose }
  }

  // Owner decision (2026-10-04): any authenticated user may create or edit a
  // scraper, so Save works for both roles — creating (scraper=null) and editing.
  it.each([
    ['non-admin', false, 'create'], ['non-admin', false, 'edit'],
    ['admin', true, 'create'], ['admin', true, 'edit'],
  ] as const)('saves for a %s (%s)', async (_role, isAdmin, mode) => {
    const user = userEvent.setup()
    const { onSave } = renderWith(isAdmin, mode === 'create' ? null : makeScraper({}))

    const save = saveButton()
    expect(save).toBeEnabled()
    expect(save).not.toHaveAttribute('title', ADMIN_ONLY_TITLE)
    await user.click(save)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('locks the frequency for a non-admin and saves the stored value', async () => {
    // The server keeps a non-admin's schedule, so offering the choice would be a lie.
    const user = userEvent.setup()
    const { onSave } = renderWith(false, makeScraper({ frequency_minutes: 360 }))

    const frequency = frequencySelect()
    expect(frequency).toBeDisabled()
    expect(frequency).toHaveAttribute('title', ADMIN_ONLY_TITLE)
    await user.selectOptions(frequency, '15')
    await user.click(saveButton())
    expect(at(onSave.mock.calls, 0)[0].frequency_minutes).toBe(360)
  })

  it('lets an admin change the frequency', async () => {
    // Positive control: disabling the select for everyone would pass the case above.
    const user = userEvent.setup()
    const { onSave } = renderWith(true, makeScraper({ frequency_minutes: 360 }))

    const frequency = frequencySelect()
    expect(frequency).toBeEnabled()
    expect(frequency).not.toHaveAttribute('title', ADMIN_ONLY_TITLE)
    await user.selectOptions(frequency, '15')
    await user.click(saveButton())
    expect(at(onSave.mock.calls, 0)[0].frequency_minutes).toBe(15)
  })

  it.each([true, false])('still closes on cancel (isAdmin=%s)', async (isAdmin) => {
    const user = userEvent.setup()
    const { onClose } = renderWith(isAdmin)

    const cancel = screen.getByRole('button', { name: i18n.t('editor.cancel', { ns: 'scrapers' }) })
    expect(cancel).toBeEnabled()
    await user.click(cancel)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('leaves the rest of the form editable (isAdmin=%s)', (isAdmin) => {
    renderWith(isAdmin)

    expect(screen.getByDisplayValue('Test scraper')).toBeEnabled()
    expect(screen.getByDisplayValue('https://example.com/reviews')).toBeEnabled()
  })
})

describe('ScraperEditor save feedback', () => {
  const saveName = () => i18n.t('editor.save', { ns: 'scrapers' })

  it('shows a rejected save as an alert and keeps Save available', () => {
    render(<ScraperEditor scraper={makeScraper({})} isAdmin onSave={vi.fn()} onClose={vi.fn()} saveError="A scraper may list at most 20 URLs" />)

    expect(screen.getByRole('alert')).toHaveTextContent('A scraper may list at most 20 URLs')
    expect(screen.getByRole('button', { name: saveName() })).toBeEnabled()
  })

  it('shows no alert without an error and disables Save while one is in flight', () => {
    render(<ScraperEditor scraper={makeScraper({})} isAdmin onSave={vi.fn()} onClose={vi.fn()} isSaving />)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: saveName() })).toBeDisabled()
  })
})
