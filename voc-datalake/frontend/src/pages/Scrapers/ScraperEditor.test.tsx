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
 * Admin gate on Save: `POST /scrapers` is admin-gated server-side, and this
 * editor's Save is the only UI entrance to it. The gate shipped absent — the
 * component took no `isAdmin` at all — while three comments elsewhere justified
 * leaving Edit and New Source enabled by claiming that "the form's own Save
 * carries the gate". Measured before the fix, rendering with a non-admin: Save
 * `disabled` false, `title` null, and one `onSave` call. Because
 * `Scrapers.handleSaveScraper` closes the editor unconditionally and its
 * `saveMutation` has no `onError`, the 403 was invisible: the modal closed as
 * though the edit had been stored.
 *
 * The non-admin cases assert the CALLBACK is not invoked, not merely that the
 * button carries `disabled` — the request not being issued is the observable, and
 * `disabled` on a styled button is easy to render and easy to bypass.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import ScraperEditor from './ScraperEditor'
// Imported rather than restated: the subject of these assertions is the GATE, not
// the wording. See the constant's own docstring.
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
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
    <ScraperEditor scraper={scraper} template={template} isAdmin onSave={vi.fn()} onClose={vi.fn()} />
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

describe('ScraperEditor admin gate on Save', () => {
  /** The Save button, located by its lucide icon rather than by `title`: `title`
   *  is part of what these assertions are about, and the accessible name changes
   *  with the locale. */
  function saveButton(): HTMLElement {
    const found = screen.getAllByRole('button').find(
      (el) => el.querySelector('svg.lucide-save') !== null
    )
    if (found == null) throw new Error('no button carrying svg.lucide-save')
    return found
  }

  function renderWith(isAdmin: boolean, onSave = vi.fn(), onClose = vi.fn()) {
    render(
      <ScraperEditor
        scraper={makeScraper({})}
        isAdmin={isAdmin}
        onSave={onSave}
        onClose={onClose}
      />
    )
    return { onSave, onClose }
  }

  it('does not save for a non-admin', async () => {
    const user = userEvent.setup()
    const { onSave } = renderWith(false)

    const save = saveButton()
    expect(save).toBeDisabled()
    expect(save).toHaveAttribute('title', ADMIN_ONLY_TITLE)
    await user.click(save)
    // The observable: the request is never issued. Asserting only `disabled`
    // would pass against a button that fires anyway.
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves for an admin', async () => {
    // Positive control. Without it, disabling Save unconditionally would satisfy
    // the case above while making the editor useless for the administrators it
    // exists for.
    const user = userEvent.setup()
    const { onSave } = renderWith(true)

    const save = saveButton()
    expect(save).toBeEnabled()
    expect(save).not.toHaveAttribute('title', ADMIN_ONLY_TITLE)
    await user.click(save)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('still closes on cancel (isAdmin=%s)', async (isAdmin) => {
    // The gate's boundary: a non-admin who opened this editor to READ a config
    // (`GET /scrapers` is deliberately open) must still be able to leave it. This
    // is what stops a future "disable everything for non-admins" from passing the
    // first case.
    const user = userEvent.setup()
    const { onClose } = renderWith(isAdmin)

    const cancel = screen.getByRole('button', { name: i18n.t('editor.cancel', { ns: 'scrapers' }) })
    expect(cancel).toBeEnabled()
    await user.click(cancel)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])('leaves the form readable and editable (isAdmin=%s)', (isAdmin) => {
    // Only Save is gated. The fields stay interactive because a non-admin can
    // already read every one of them through `GET /scrapers`, so blanking or
    // freezing the form would hide data the API serves them.
    renderWith(isAdmin)

    const name = screen.getByDisplayValue('Test scraper')
    expect(name).toBeEnabled()
    expect(screen.getByDisplayValue('https://example.com/reviews')).toBeEnabled()
  })
})
