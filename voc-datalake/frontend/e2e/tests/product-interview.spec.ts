/**
 * 5.x Product tab — "Fill with AI assistant" (ProductTabHeader.tsx, projectDetail
 * `product.assistant.*`): on a public `e2e-<run id>-product-interview` project
 * (lib/projects.ts, admin API create, ledger-recorded), the button opens the
 * floating assistant panel on a new conversation with the interview request as
 * its UNSENT draft (the composer names the product description and the interview),
 * and the panel closes again.
 *
 * Sending: under the dev mock (`E2E_MOCK=1`) the draft is sent and the scripted
 * reply shows in the conversation. In PRODUCTION nothing is sent unless
 * `E2E_ASSISTANT_SEND=1` (lib/optIn.ts): a send is a billed model run, and its
 * conversation goes in the ledger (lib/test.ts) for cleanup. A public project is
 * editable by every signed-in user, so both roles see the button.
 *
 * Mock run (from voc-datalake/frontend/e2e, mock + vite on your own ports):
 *   E2E_MOCK=1 E2E_SITE=http://127.0.0.1:<VP> E2E_API=http://127.0.0.1:<MP> E2E_OUT=/tmp/e2e-mock \
 *     npx playwright test -c playwright.config.ts --reporter=line tests/product-interview.spec.ts
 */
import { expect, type Page } from '@playwright/test'
import { test } from '../lib/test'
import { composer, conversationLog } from '../lib/assistant'
import { MOCK, RUN_PREFIX } from '../lib/env'
import { assertStep, isApi, roleOf, settle, site } from '../lib/fixtures'
import { optIn } from '../lib/optIn'
import { ensureE2eProject } from '../lib/projects'

const PROJECT_NAME = `${RUN_PREFIX}product-interview`
/** projectDetail.json `product.assistant.button` / `.prompt`. */
const FILL_BUTTON = 'Fill with AI assistant'
const INTERVIEW_PROMPT = "Interview me to fill in this project's product description."
/** assistant.json: the empty-conversation welcome of a new chat. */
const EMPTY_CONVERSATION = 'How can I help?'
/** How long a sent interview request may run before its reply must show. */
const REPLY_TIMEOUT_MS = 170_000
/** Opt-in switch for a production send (a billed model run). */
const ASSISTANT_SEND_SWITCH = 'E2E_ASSISTANT_SEND'

const fillButton = (page: Page) => page.getByRole('button', { name: FILL_BUTTON, exact: true })

async function openProductTab(page: Page, projectId: string): Promise<void> {
  await page.goto(site(`/projects/${encodeURIComponent(projectId)}?tab=product`), { waitUntil: 'domcontentloaded' })
  await settle(page, 500)
  await expect(fillButton(page)).toBeVisible()
}

/** Opens the panel from the Product tab; returns the draft the composer holds. */
async function openWithDraft(page: Page): Promise<string> {
  await fillButton(page).click()
  const box = composer(page)
  await expect(box).toBeVisible()
  await expect(box).not.toHaveValue('')
  return box.inputValue()
}

/** Sends the drafted request and waits for the reply (Send back, the log longer than the request). */
async function sendDraftAndReadReply(page: Page): Promise<string> {
  const stream = page.waitForResponse((r) => isApi(r, 'POST', /\/chat\/stream$/), { timeout: REPLY_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).first().click()
  expect((await stream).status(), 'POST /chat/stream').toBe(200)
  await expect(page.getByRole('button', { name: 'Stop', exact: true }).filter({ visible: true })).toHaveCount(0, { timeout: REPLY_TIMEOUT_MS })
  await expect(conversationLog(page)).toContainText(INTERVIEW_PROMPT)
  await expect.poll(async () => (await replyText(page)).length, { timeout: REPLY_TIMEOUT_MS }).toBeGreaterThan(0)
  return replyText(page)
}

/** The conversation's text without the user's request: what the assistant answered. */
async function replyText(page: Page): Promise<string> {
  return (await conversationLog(page).innerText()).replace(INTERVIEW_PROMPT, '').trim()
}

async function closePanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close assistant' }).click()
  await expect(page.getByRole('textbox', { name: 'Message the assistant' }).filter({ visible: true })).toHaveCount(0)
}

test.describe('product interview', () => {
  let projectId = ''

  test.beforeAll(async () => {
    projectId = await ensureE2eProject(PROJECT_NAME, 'public')
  })

  test('Fill with AI assistant opens the panel with the interview drafted, not sent', async ({ page }, testInfo) => {
    const role = roleOf(testInfo)
    const streams: string[] = []
    page.on('request', (r) => { if (isApi(r, 'POST', /\/chat\/stream$/)) streams.push(r.url()) })
    await assertStep(page, role, 'product-interview-draft', async () => {
      await openProductTab(page, projectId)
      const draft = await openWithDraft(page)
      expect(draft).toBe(INTERVIEW_PROMPT)
      expect(draft).toMatch(/interview/i)
      expect(draft).toMatch(/product/i)
      // A draft: nothing reached the stream, and the conversation is a new, empty one.
      expect(streams, 'no POST /chat/stream before Send').toEqual([])
      // (an empty conversation renders the welcome, not a log: assistant.json `title` of the empty state)
      await expect(page.getByRole('region', { name: EMPTY_CONVERSATION, exact: true }).filter({ visible: true })).toHaveCount(1)
      await expect(conversationLog(page)).toHaveCount(0)
      await closePanel(page)
    })
  })

  test('the drafted interview request gets a reply when sent', async ({ page }, testInfo) => {
    test.skip(!MOCK && !optIn(ASSISTANT_SEND_SWITCH), 'production sends only with E2E_ASSISTANT_SEND=1 (a billed model run)')
    const role = roleOf(testInfo)
    await assertStep(page, role, 'product-interview-send', async () => {
      await openProductTab(page, projectId)
      await openWithDraft(page)
      const reply = await sendDraftAndReadReply(page)
      expect(reply.length).toBeGreaterThan(0)
      // The mock's scripted answer on a project page (mock-server.js firstRunEvents).
      if (MOCK) expect(reply).toContain('Here is the project')
      await closePanel(page)
    })
  })
})
