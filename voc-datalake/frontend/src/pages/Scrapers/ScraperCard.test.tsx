/**
 * @fileoverview Tests for ScraperCard.
 *
 * Invalid base_url resilience (issue #167): a render-time `new URL(...)` TypeError
 * on a missing or malformed base_url crashed the entire /scrapers route. The card
 * must render for every value runtime data has been observed to carry: undefined
 * (mock server, older configs), empty/whitespace, scheme-less, and garbage.
 *
 * The admin gate on Run and Delete: `POST /scrapers/{id}/run` and
 * `DELETE /scrapers/{id}` are admin-gated server-side, so those controls must not
 * issue a request a non-admin's 403 would swallow. See that describe block for the
 * measurements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import ScraperCard from './ScraperCard'
import { scraperDomainLabel } from './scraperUrl'
import { DEFAULT_SCRAPER } from './constants'
// Imported, not restated — see PluginConfigModal.test.tsx.
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
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

/** Callbacks the admin-gate cases below assert on; `vi.clearAllMocks()` resets them. */
const onEdit = vi.fn()
const onDelete = vi.fn()
const onRun = vi.fn()

function renderCard(scraper: ScraperConfig, isAdmin = true) {
  return render(
    <ScraperCard
      scraper={scraper}
      isAdmin={isAdmin}
      onEdit={onEdit}
      onDelete={onDelete}
      onRun={onRun}
    />
  )
}

/** The button carrying *iconClass*, e.g. `lucide-play`. */
function buttonWithIcon(iconClass: string): HTMLElement {
  const found = screen.getAllByRole('button').find(
    (el) => el.querySelector(`svg.${iconClass}`) !== null
  )
  if (found == null) throw new Error(`no button carrying svg.${iconClass}`)
  return found
}

describe('scraperDomainLabel', () => {
  it('resolves the shipped not-configured string from the i18n test setup', () => {
    // Guard against vacuous passes: if the key stopped resolving, t() would
    // return the raw key and component + test would "agree" on it.
    expect(NOT_CONFIGURED).not.toContain('card.notConfigured')
  })

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

  it('falls back to the raw value for parseable URLs with an empty hostname', () => {
    // mailto:/file: URLs construct successfully but have hostname === '' —
    // an empty label would look like broken rendering.
    expect(scraperDomainLabel('mailto:x@example.com', NOT_CONFIGURED)).toBe('mailto:x@example.com')
    expect(scraperDomainLabel('file:///tmp/reviews.html', NOT_CONFIGURED)).toBe('file:///tmp/reviews.html')
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

describe('ScraperCard frequency resilience (issue #169)', () => {
  it('renders a dash instead of "undefinedm" for a runtime record without frequency', () => {
    const scraper = makeScraper({ base_url: 'https://example.com' })
    // The wire can deliver records persisted before frequency_minutes
    // existed; static types say it is required, runtime reality disagrees.
    Reflect.deleteProperty(scraper, 'frequency_minutes')

    renderCard(scraper)

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
  })

  it('renders the human label for a known frequency', () => {
    renderCard(makeScraper({ frequency_minutes: 30 }))

    expect(screen.getByText('Every 30 minutes')).toBeInTheDocument()
  })

  it('renders Manual only for the normalized no-schedule default (0)', () => {
    renderCard(makeScraper({ frequency_minutes: 0 }))

    expect(screen.getByText('Manual only')).toBeInTheDocument()
  })
})

/**
 * `POST /scrapers/{id}/run` and `DELETE /scrapers/{id}` became admin-gated
 * server-side in this change: `run_scraper` invokes the webscraper (a billed
 * third-party fetch, previously callable in a loop by anyone with an account) and
 * `delete_scraper` rewrites `webscraper_configs` on the shared API-credentials
 * secret. Measured before the gate as a `users`-group caller: 200 with one
 * `lambda:Invoke` and one `SCRAPER_RUN#` row, and 200 with one `put_secret_json`.
 *
 * These cards are the UI entrance to both, rendered on the Scrapers page for every
 * authenticated user, so the controls are disabled rather than left to fire a 403.
 * The server is the boundary; this only stops the page offering an action it knows
 * will fail.
 *
 * Each non-admin case asserts the CALLBACK was not invoked, not merely that the
 * button carries `disabled` — matching `AppConfigComponents.test.tsx`. The
 * `isAdmin` cases are its positive controls, so disabling everything cannot pass.
 */
describe('ScraperCard admin gate on Run and Delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const withUrl = () => makeScraper({ base_url: 'https://shop.example.com/reviews' })

  describe('when the user is not an admin', () => {
    it('does not trigger a run', async () => {
      const user = userEvent.setup()
      renderCard(withUrl(), false)

      const run = buttonWithIcon('lucide-play')
      expect(run).toBeDisabled()
      expect(run).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(run)
      expect(onRun).not.toHaveBeenCalled()
    })

    it('does not delete the scraper', async () => {
      const user = userEvent.setup()
      renderCard(withUrl(), false)

      const del = buttonWithIcon('lucide-trash2')
      expect(del).toBeDisabled()
      expect(del).toHaveAttribute('title', ADMIN_ONLY_TITLE)
      await user.click(del)
      expect(onDelete).not.toHaveBeenCalled()
    })
  })

  describe('when the user is an admin', () => {
    it('triggers a run', async () => {
      const user = userEvent.setup()
      renderCard(withUrl(), true)

      const run = buttonWithIcon('lucide-play')
      expect(run).toBeEnabled()
      await user.click(run)
      expect(onRun).toHaveBeenCalledTimes(1)
    })

    it('deletes the scraper', async () => {
      const user = userEvent.setup()
      renderCard(withUrl(), true)

      const del = buttonWithIcon('lucide-trash2')
      expect(del).toBeEnabled()
      await user.click(del)
      expect(onDelete).toHaveBeenCalledTimes(1)
    })
  })

  describe('regardless of admin status', () => {
    /**
     * The gate's boundary. A non-admin can already read this configuration through
     * `GET /scrapers`, which stays deliberately open, so disabling Edit would hide
     * data the API serves them. Pinning it stops a future "disable everything for
     * non-admins" from passing the cases above.
     *
     * What makes enabling Edit safe is that the editor's own Save is gated for
     * `POST /scrapers` — asserted in `ScraperEditor.test.tsx`, not assumed here. An
     * earlier version of this comment claimed that gate existed when it did not:
     * `ScraperEditor` took no `isAdmin`, so a non-admin's Save issued the request
     * and the modal closed as though it had succeeded. If that gate is ever
     * removed, this case becomes the wrong decision rather than a boundary.
     */
    it.each([true, false])('opens the editor (isAdmin=%s)', async (isAdmin) => {
      const user = userEvent.setup()
      renderCard(withUrl(), isAdmin)

      const edit = buttonWithIcon('lucide-settings')
      expect(edit).toBeEnabled()
      await user.click(edit)
      expect(onEdit).toHaveBeenCalledTimes(1)
    })

    it.each([true, false])('renders the scraper details (isAdmin=%s)', (isAdmin) => {
      renderCard(withUrl(), isAdmin)

      expect(screen.getByText('shop.example.com')).toBeInTheDocument()
      expect(screen.getByText('Test scraper')).toBeInTheDocument()
    })
  })
})
