/**
 * Opening a row's prototype outside the app, and what the row says about how long
 * that keeps working.
 *
 * The embedded frame is 384px inside half a row, which is enough to recognise a
 * prototype and not enough to walk a room through one — so the row offers it in a
 * new tab. Three properties of that affordance are cheap to lose and invisible in
 * review, so all three are pinned here:
 *
 * 1. **It is an anchor.** A prototype URL is a signed credential, so the obvious
 *    "improvement" is a button that fetches a fresh signature and then calls
 *    `window.open`. That trades a 403 for a popup blocker (see
 *    components/prototypeLinkLifetime). A `getByRole('link')` assertion is what
 *    makes that rewrite fail instead of shipping.
 * 2. **The deadline is stated.** A link that silently dies is the failure mode this
 *    guards, and it must be visible text rather than a tooltip.
 * 3. **A row with no prototype offers nothing.** Most rows have no prototype, and
 *    an anchor pointing at `undefined` is worse than no anchor.
 *
 * No fake timers: the expired branch is chosen by putting `Expires` either side of
 * the real clock. The scheduling half of this feature needs timers and lives in
 * Prioritization.prototypeRefresh.test.tsx, so they stay contained there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import i18n from 'i18next'
import './prioritization-mock-fixtures'
import {
  stubOneRowProject, stubProjectHolding, stubFreshlySignedPrototype, legacyPrototypeDoc, lapsedPrototypeDoc, HOUR_MS, PROTOTYPE_PATH, escapeRegExp, signedUrl, prototypeDoc,
} from './prioritization-fixtures'
import { openRow, expectScoresPanelShown } from './prioritization-render-fixtures'
import { formatExpiry } from '../../components/prototypeLinkLifetime'

const { t } = i18n

const openLinkName = new RegExp(escapeRegExp(t('components:prototypeLink.openNewTab')), 'i')
const downloadLinkName = new RegExp(escapeRegExp(t('components:prototypeLink.downloadHtml')), 'i')

// Hoisted by vitest, so placed with the helpers that drive the page they stub.

/**
 * Nothing offering to open the prototype, by TEXT and not only by role.
 *
 * Both, because they fail in different directions. Role alone misses an affordance
 * rendered with a broken address: `<a href="">` loses the `link` role in
 * aria-query, so a regression that offered "Open in new tab" pointing nowhere would
 * pass a role-only assertion while being exactly the defect worth catching.
 */
function expectNoOpenAffordance(): void {
  expect(screen.queryByRole('link', { name: openLinkName })).not.toBeInTheDocument()
  expect(screen.queryByText(openLinkName)).not.toBeInTheDocument()
}

/** Open the row, wait for the expansion to render, and check it offers no way to open the prototype. */
async function expectOpenedRowWithoutOpenAffordance(): Promise<void> {
  await openRow()

  await expectScoresPanelShown()
  expectNoOpenAffordance()
}

beforeEach(() => {
  vi.clearAllMocks()
  stubOneRowProject()
})

describe('opening a row\'s prototype in a new tab', () => {
  it('offers the prototype as a plain anchor at its signed address', async () => {
    const url = stubFreshlySignedPrototype()

    await openRow()

    // A LINK, not a button. A button that fetched a fresh signature and then called
    // window.open would be blocked as a popup — freshness is the scheduler's job.
    const link = await screen.findByRole('link', { name: openLinkName })
    expect(link).toHaveAttribute('href', url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(screen.queryByRole('button', { name: openLinkName })).not.toBeInTheDocument()
  })

  it('offers no open affordance for a row whose project has no prototype', async () => {
    stubProjectHolding()

    await expectOpenedRowWithoutOpenAffordance()
  })

  it('offers no open affordance for a legacy prototype, which has no address', async () => {
    // Pre-migration prototypes are inline HTML with no `prototype_url`. They still
    // preview in the frame; there is simply nothing to open.
    stubProjectHolding(legacyPrototypeDoc())

    await expectOpenedRowWithoutOpenAffordance()
  })

  it('leaves downloading to the project page, which is where artifacts are filed', async () => {
    await openRow()

    await screen.findByRole('link', { name: openLinkName })
    expect(screen.queryByRole('link', { name: downloadLinkName })).not.toBeInTheDocument()
    expect(screen.queryByText(downloadLinkName)).not.toBeInTheDocument()
  })
})

describe('what the row says about the prototype link\'s lifetime', () => {
  it('states when the link stops working', async () => {
    const expiresAt = Date.now() + HOUR_MS
    stubProjectHolding(prototypeDoc(signedUrl(expiresAt, 'sig-1')))

    await openRow()

    // Formatted the way the component does, so this holds in any timezone and under
    // any locale rather than only the one the suite happens to run in.
    const expected = formatExpiry(Math.floor(expiresAt / 1000) * 1000, Date.now(), 'en')
    expect(await screen.findByText(
      new RegExp(`Link valid until ${escapeRegExp(expected)}`),
    )).toBeInTheDocument()
  })

  it('says the link is session-scoped in VISIBLE text, not a tooltip', async () => {
    await openRow()

    expect(await screen.findByText(/tied to your session, not a share link/i)).toBeInTheDocument()
    expect(screen.queryByTitle(/tied to your session/i)).not.toBeInTheDocument()
  })

  it('points the open link at that warning for assistive technology', async () => {
    await openRow()

    const note = await screen.findByText(/tied to your session/i)
    const noteId = note.closest('span[id]')?.getAttribute('id')
    expect(noteId).toBeTruthy()
    expect(screen.getByRole('link', { name: openLinkName })).toHaveAttribute('aria-describedby', noteId)
  })

  it('does not dangle aria-describedby when there is no readable deadline', async () => {
    // An unsigned URL renders no note, so the anchor must not reference a missing id.
    stubProjectHolding(prototypeDoc(PROTOTYPE_PATH))

    await openRow()

    expect(await screen.findByRole('link', { name: openLinkName }))
      .not.toHaveAttribute('aria-describedby')
    expect(screen.queryByText(/Link valid until/)).not.toBeInTheDocument()
  })

  it('reports a lapsed link instead of promising a window it cannot honour', async () => {
    stubProjectHolding(lapsedPrototypeDoc())

    await openRow()

    expect(await screen.findByText(/Link expired/)).toBeInTheDocument()
    expect(screen.queryByText(/Link valid until/)).not.toBeInTheDocument()
  })
})
