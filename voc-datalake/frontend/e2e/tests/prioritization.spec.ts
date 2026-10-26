/**
 * P3 — Prioritization board and room voting (E2E-COVERAGE-GAPS R2, R12, M36, M37).
 *
 * 1. The board renders for the role (rows or its empty state), with no 5xx.
 * 2. The public ballot `/vote/:sessionId` in a FRESH, UNAUTHENTICATED context
 *    (a room's phone): an id that names no session says so, and the public
 *    submit route refuses it without a session (404) — no login, no redirect.
 * 3. Room vote, end to end, on a row: the facilitator opens a vote on the board
 *    (QR + "0 of N ballots in"), a phone with no session submits within the cap
 *    ("Ballot recorded", the board counts it), a capped session refuses the
 *    ballot past its cap (429, "already collected as many ballots"), the
 *    facilitator closes the vote, and the phone then refuses ("This vote is not
 *    open"; the API answers 409).
 *
 * PRODUCTION runs 1 and 2 only. Step 3 writes BALLOTS, which live in the
 * PRIORITIZATION partition with no TTL and no delete route (a project delete
 * does not remove them either), so — like the feedback-form submit in
 * writes.spec.ts — it is never done against a shared deployment. It runs against
 * the local dev mock (playwright.mock.config.ts), which serves the same wire
 * shapes (mock-server.js, ballots_handler.py contract).
 */
import { expect, type Browser, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { anonymousContext } from '../lib/mode'
import { MOCK, apiUrl } from '../lib/env'
import { isRecord } from '../lib/guards'
import { roleOf, runStep, settle, site } from '../lib/fixtures'

/** A session id in the real format (`vs_` + 32 hex) that no session will ever have. */
const UNKNOWN_SESSION = `vs_${'0'.repeat(31)}e`
const MOCK_ROW = 'row_proj_1_default'
const NOT_OPEN = 'This vote is not open'
/** The board's two empty states (prioritization `empty.title` / `empty.wrongTypeTitle`). */
const EMPTY_TITLES = ['No Documents Found', 'No Scorable Documents']
const ANY_AXES = { impact: 3, time_to_market: 3, strategic_fit: 3, confidence: 3 }

/** The `session` object of a voting-session response, or {}. */
function sessionOf(body: unknown): Record<string, unknown> {
  return isRecord(body) && isRecord(body['session']) ? body['session'] : {}
}

/** The session's id ('' when the response carried none). */
function sessionIdOf(body: unknown): string {
  const id = sessionOf(body)['session_id']
  return typeof id === 'string' ? id : ''
}

async function submitOnBallotPage(page: Page): Promise<void> {
  await page.getByLabel('Impact').fill('4')
  await page.getByLabel('Your name (optional)').fill('e2e room')
  await page.getByRole('button', { name: 'Submit ballot' }).click()
}

/** A NEW device (no session, no stored ballot id) submits on `/vote/{id}`; returns the submit's status. */
async function voteFromNewDevice(browser: Browser, sessionId: string, expectHeading: string, expectDetail?: RegExp): Promise<number> {
  const device = await anonymousContext(browser)
  try {
    const page = await device.newPage()
    await page.goto(site(`/vote/${sessionId}`), { waitUntil: 'domcontentloaded' })
    const submitted = page.waitForResponse((r) => /\/submit$/.test(new URL(r.url()).pathname))
    await submitOnBallotPage(page)
    const status = (await submitted).status()
    await expect(page.getByRole('heading', { name: expectHeading })).toBeVisible()
    if (expectDetail !== undefined) await expect(page.getByText(expectDetail)).toBeVisible()
    return status
  } finally {
    await device.close()
  }
}

test.describe('prioritization and room voting', () => {
  test('board renders for the role', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const { record, problems } = await runStep({
      page, role, theme: 'dark', step: 'p3-prioritization-board',
      action: async (recorder) => {
        await page.goto(site('/prioritization'), { waitUntil: 'domcontentloaded' })
        await settle(page)
        await expect(page.getByRole('heading', { name: 'Prioritization', level: 1 })).toBeVisible()
        const rows = await page.locator('button[aria-expanded] h3').count()
        const empty = await page.getByRole('heading').filter({ hasText: new RegExp(`^(${EMPTY_TITLES.join('|')})$`) }).count()
        recorder.note(`rows: ${rows}, empty state: ${empty > 0}`)
        expect(rows > 0 || empty > 0, 'rows or the empty state').toBe(true)
      },
    })
    expect(problems, record.screenshot ?? '').toEqual([])
  })

  test('public ballot: an unknown session, unauthenticated', async ({ browser }, testInfo) => {
    test.skip(roleOf(testInfo) !== 'admin', 'public route: one role is enough')
    const context = await anonymousContext(browser)
    try {
      const page = await context.newPage()
      const { record, problems } = await runStep({
        page, role: 'user', theme: 'dark', step: 'p3-vote-unknown-anonymous',
        action: async () => {
          await page.goto(site(`/vote/${UNKNOWN_SESSION}`), { waitUntil: 'domcontentloaded' })
          await expect(page.getByRole('heading', { name: 'Score this proposal', level: 1 })).toBeVisible()
          await expect(page.getByRole('heading', { name: NOT_OPEN })).toBeVisible()
          await expect(page.getByText('This link does not open a vote.', { exact: false })).toBeVisible()
          // Public: no redirect to /login, no form.
          expect(new URL(page.url()).pathname).toBe(`/vote/${UNKNOWN_SESSION}`)
          await expect(page.getByRole('button', { name: 'Submit ballot' })).toHaveCount(0)
        },
      })
      expect(problems, record.screenshot ?? '').toEqual([])
      // The public submit, with no Authorization header at all.
      const refused = await fetch(`${apiUrl()}/voting-sessions/${UNKNOWN_SESSION}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ANY_AXES),
      })
      expect(refused.status).toBe(404)
    } finally {
      await context.close()
    }
  })

  test('room vote: open on the board, ballot from a phone within the cap, cap refusal, close, refusal', async ({ page, browser }, testInfo) => {
    test.skip(!MOCK, 'writes undeletable ballots: dev mock only (see the header)')
    test.skip(roleOf(testInfo) !== 'admin', 'facilitator flow runs as the admin')

    // ── the facilitator opens a vote on the board
    await page.goto(site('/prioritization'), { waitUntil: 'domcontentloaded' })
    await settle(page, 600)
    await page.locator('button[aria-expanded]').filter({ has: page.locator('h3') }).first().click()
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/voting-sessions$/.test(new URL(r.url()).pathname))
    await page.getByRole('button', { name: 'Open a room vote' }).click()
    const createdBody: unknown = await (await created).json()
    const session = sessionOf(createdBody)
    const sessionId = sessionIdOf(createdBody)
    expect(sessionId).not.toBe('')
    await expect(page.getByRole('img', { name: /QR code opening the anonymous ballot page/ })).toBeVisible()
    await expect(page.getByText(`0 of ${String(session['ballot_cap'])} ballots in`)).toBeVisible()

    // ── a phone with NO session submits within the cap
    const phone = await anonymousContext(browser)
    try {
      const ballot = await phone.newPage()
      await ballot.goto(site(`/vote/${sessionId}`), { waitUntil: 'domcontentloaded' })
      await expect(ballot.getByRole('heading', { name: 'Score this proposal', level: 1 })).toBeVisible()
      await submitOnBallotPage(ballot)
      await expect(ballot.getByRole('heading', { name: 'Ballot recorded' })).toBeVisible()
      // The facilitator's count follows (the panel polls GET /voting-sessions/{sid}).
      await expect(page.getByText(`1 of ${String(session['ballot_cap'])} ballots in`)).toBeVisible({ timeout: 20_000 })

      // ── a session capped at one ballot refuses the second device
      const cappedBody = (await apiCall('admin', 'POST', '/voting-sessions', { row_id: MOCK_ROW, row_title: 'e2e capped', ballot_cap: 1 })).body
      expect(sessionOf(cappedBody)['ballot_cap']).toBe(1)
      const cappedId = sessionIdOf(cappedBody)
      expect(await voteFromNewDevice(browser, cappedId, 'Ballot recorded'), 'first device').toBe(200)
      expect(await voteFromNewDevice(browser, cappedId, NOT_OPEN, /already collected as many ballots as it accepts/), 'second device, past the cap').toBe(429)

      // ── the facilitator closes the vote; the phone is refused
      await page.getByRole('button', { name: 'Close the vote' }).click()
      await expect(page.getByText('This vote is closed. No further ballots are accepted.')).toBeVisible()
      await expect(page.getByRole('img', { name: /QR code/ })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Open another vote' })).toBeVisible()

      await ballot.reload({ waitUntil: 'domcontentloaded' })
      await expect(ballot.getByRole('heading', { name: NOT_OPEN })).toBeVisible()
      await expect(ballot.getByText(/The facilitator has closed this vote/)).toBeVisible()
      const late = await apiCall('user', 'POST', `/voting-sessions/${sessionId}/submit`, ANY_AXES)
      expect(late.status).toBe(409)
      expect(isRecord(late.body) ? late.body['reason'] : undefined).toBe('closed')
    } finally {
      await phone.close()
    }
  })
})
