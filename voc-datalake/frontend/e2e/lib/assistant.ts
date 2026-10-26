/**
 * Drives the unified AI assistant (floating panel or the /chat page) the way a
 * user does: open it, New chat, type, Send, approve or decline a card. Shared
 * by every track; writes.spec.ts keeps its own single-message flow.
 *
 * Two ways to wait for a run:
 * - `ask` / `approve` / `decline` read the run from the SSE tap (lib/sse.ts),
 *   so `installSseTap` must run before the page's first navigation. Use them
 *   when the step judges the stream's tool calls and results.
 * - `askAssistant` needs no tap: it watches the UI (Send back, Stop gone),
 *   approves up to `approveMax` cards on the way, and measures `/chat/stream`
 *   headers, TTFB and total from the browser's request timing.
 */
import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test'
import { apiUrl } from './env'
import { timingOf } from './recorder'
import { streamRuns, summarize, waitForRunEnd, type StreamSummary } from './sse'

export const ASSISTANT_RUN_TIMEOUT_MS = 170_000

const visible = (locator: Locator): Locator => locator.filter({ visible: true }).first()

export const composer = (page: Page): Locator => visible(page.getByRole('textbox', { name: 'Message the assistant' }))

/** The conversation log in view (the panel and /chat both render role=log "Conversation"). */
export const conversationLog = (page: Page): Locator => visible(page.getByRole('log', { name: 'Conversation' }))

const sendButton = (page: Page): Locator => visible(page.getByRole('button', { name: 'Send', exact: true }))
const stopButton = (page: Page): Locator => visible(page.getByRole('button', { name: 'Stop', exact: true }))

/**
 * Opens the floating panel if it is closed (its open state is persisted):
 * the floating bubble ("Open assistant") or a project header's "Ask the assistant".
 */
export async function openFloating(page: Page): Promise<Locator> {
  const box = composer(page)
  if (!(await box.isVisible().catch(() => false))) {
    await visible(page.getByRole('button', { name: /^(Open assistant|Ask the assistant)$/ })).click()
  }
  await expect(box).toBeVisible()
  return box
}

/** "New chat" in the panel header; the /chat sidebar labels the same action "New conversation". */
export async function newChat(page: Page): Promise<void> {
  await visible(page.getByRole('button', { name: /^(New chat|New conversation)$/ })).click()
  await expect(composer(page)).toHaveValue('')
}

const sameApi = (url: URL): boolean => url.origin === new URL(apiUrl()).origin

function isConversationSave(request: Request): boolean {
  const url = new URL(request.url())
  return request.method() === 'POST' && sameApi(url)
    && /\/chat\/conversations\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith('/_list')
}

function isStream(request: Request): boolean {
  const url = new URL(request.url())
  return request.method() === 'POST' && sameApi(url) && /\/chat\/stream$/.test(url.pathname)
}

/** The conversation id a save request carries in its path ('' when none). */
const savedId = (request: Request): string => decodeURIComponent(new URL(request.url()).pathname.split('/').pop() ?? '')

export interface AskResult {
  summary: StreamSummary
  /** The POST /chat/conversations/{id} that followed the run (null: none within the timeout). */
  save: { status: number; id: string } | null
}

/** Waits for the run at `index` and the conversation save that follows it. */
async function finishRun(page: Page, index: number, saved: Promise<Response | null>): Promise<AskResult> {
  const summary = summarize(await waitForRunEnd(page, index, ASSISTANT_RUN_TIMEOUT_MS))
  const response = await saved
  return { summary, save: response === null ? null : { status: response.status(), id: savedId(response.request()) } }
}

const saveAfter = (page: Page): Promise<Response | null> =>
  page.waitForResponse((res) => isConversationSave(res.request()), { timeout: ASSISTANT_RUN_TIMEOUT_MS + 15_000 }).catch(() => null)

/** Sends a message without waiting for the run (the mid-stream reload test). Returns the run's index. */
export async function sendOnly(page: Page, text: string): Promise<number> {
  const index = (await streamRuns(page)).length
  await composer(page).fill(text)
  await sendButton(page).click()
  return index
}

/** Sends one message and waits for that run to end (finished, interrupted or failed). */
export async function ask(page: Page, text: string): Promise<AskResult> {
  const saved = saveAfter(page)
  const index = await sendOnly(page, text)
  return finishRun(page, index, saved)
}

export const lastApprovalCard = (page: Page): Locator => page.getByTestId('approval-card').last()

/**
 * Clicks Approve on the newest card and waits for the resume run. `write` is
 * the REST response the SPA made to carry the write out (null: none in 60 s).
 */
export async function approve(page: Page, writeMatcher: (r: Response) => boolean): Promise<AskResult & { write: Response | null }> {
  const card = lastApprovalCard(page)
  await expect(card).toBeVisible()
  const index = (await streamRuns(page)).length
  const write = page.waitForResponse(writeMatcher, { timeout: 60_000 }).catch(() => null)
  const saved = saveAfter(page)
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  const writeResponse = await write
  const result = await finishRun(page, index, saved)
  return { ...result, write: writeResponse }
}

/** Declines the newest card and waits for the resume run. */
export async function decline(page: Page): Promise<AskResult> {
  const card = lastApprovalCard(page)
  const index = (await streamRuns(page)).length
  const saved = saveAfter(page)
  await card.getByRole('button', { name: 'Decline', exact: true }).click()
  // The decline form asks for an optional reason; its confirm button is also "Decline".
  await card.getByRole('button', { name: 'Decline', exact: true }).last().click()
  return finishRun(page, index, saved)
}

/** Which of `keywords` occur (case-insensitive) in `text`. */
export function mentioned(text: string, keywords: readonly string[]): string[] {
  const lower = text.toLowerCase()
  return keywords.filter((k) => lower.includes(k.toLowerCase()))
}

// ── UI-driven runs (no SSE tap) ───────────────────────────────────────────────

export interface AssistantTurn {
  prompt: string
  status: number | null
  headersMs: number | null
  ttfbMs: number | null
  totalMs: number | null
  runMs: number
  approvals: Array<{ state: string; title: string }>
  transcriptTail: string
  answer: string
  conversationId: string | null
}

/** After Send is back: how long to wait for the stream's requestfinished and the conversation save. */
const STREAM_SETTLE_MS = 2_000
const SAVE_SETTLE_MS = 8_000
/** A run counts as finished only after this long, so the Send button seen before Stop appears is not mistaken for the end. */
const MIN_RUN_MS = 3_000
const POLL_MS = 1_000
/** How long `/chat/stream` may take to answer with headers before the turn records status null. */
const STREAM_HEADERS_TIMEOUT_MS = 90_000

/** `promise`, or null if it has not settled within `ms`. */
function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/** Approves the first pending card and waits for it to resolve; returns its state and title. */
async function approvePending(page: Page, card: Locator, deadline: number): Promise<{ state: string; title: string }> {
  const title = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
  // Read the id first: `card` is a live "first pending" locator and matches nothing once approved.
  const id = await card.getAttribute('data-interrupt-id')
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  const resolved = page.locator(`[data-testid="approval-card"][data-interrupt-id="${id ?? ''}"]`)
  // A resolved card may collapse into a status chip and leave the DOM, so absent counts as resolved.
  const stateOf = async (): Promise<string> => (await resolved.count()) === 0 ? 'resolved' : ((await resolved.getAttribute('data-state')) ?? 'resolved')
  await expect.poll(stateOf, { timeout: Math.max(1_000, deadline - Date.now()) }).not.toMatch(/^(pending|executing)$/)
  return { state: await stateOf(), title }
}

/**
 * Waits for the run to end, approving up to `approveMax` pending approval cards
 * (each approval resumes the run). The run has ended when Send is back, Stop is
 * gone, and no card is waiting that this call may still approve.
 */
async function driveRun(page: Page, deadline: number, approveMax: number): Promise<AssistantTurn['approvals']> {
  const approvals: AssistantTurn['approvals'] = []
  const started = Date.now()
  const pending = page.locator('[data-testid="approval-card"][data-state="pending"]')
  for (;;) {
    const waiting = await pending.count()
    if (waiting > 0 && approvals.length < approveMax) {
      approvals.push(await approvePending(page, pending.first(), deadline))
      // The approved client tool runs in the page, then the run resumes: give it time to show Stop.
      await page.waitForTimeout(MIN_RUN_MS)
      continue
    }
    const idle = await sendButton(page).isVisible().catch(() => false) && !(await stopButton(page).isVisible().catch(() => false))
    if (idle && (waiting > 0 || Date.now() - started > MIN_RUN_MS)) return approvals
    if (Date.now() > deadline) throw new Error('assistant run did not finish before the deadline')
    await page.waitForTimeout(POLL_MS)
  }
}

const logText = async (page: Page): Promise<string> => (await conversationLog(page).innerText().catch(() => '')).trim()

/**
 * Opens the panel, sends `prompt`, approves up to `approveMax` approval cards
 * that appear while the run is open, and resolves when Send is back.
 */
export async function askAssistant(page: Page, prompt: string, options: { timeoutMs: number; approveMax?: number }): Promise<AssistantTurn> {
  const box = await openFloating(page)
  const before = await logText(page)
  await box.fill(prompt)
  const streamDone = page.waitForEvent('requestfinished', { predicate: isStream, timeout: options.timeoutMs }).catch(() => null)
  const saved = page.waitForRequest(isConversationSave, { timeout: options.timeoutMs }).catch(() => null)
  const sentAt = Date.now()
  const headers = page.waitForResponse((res) => isStream(res.request()), { timeout: STREAM_HEADERS_TIMEOUT_MS }).catch(() => null)
  await sendButton(page).click()
  const response = await headers
  const headersMs = response === null ? null : Date.now() - sentAt

  const approvals = await driveRun(page, sentAt + options.timeoutMs, options.approveMax ?? 0)
  const runMs = Date.now() - sentAt
  const finished = await within(streamDone, STREAM_SETTLE_MS)
  const timing = finished === null ? { durationMs: null, ttfbMs: null } : timingOf(finished)
  const transcript = await logText(page)
  const saveRequest = await within(saved, SAVE_SETTLE_MS)
  const conversationId = saveRequest === null ? '' : savedId(saveRequest)
  return {
    prompt,
    status: response?.status() ?? null,
    headersMs,
    ttfbMs: timing.ttfbMs,
    totalMs: timing.durationMs,
    runMs,
    approvals,
    transcriptTail: transcript.slice(-600).replace(/\s+/g, ' '),
    answer: transcript.length > before.length ? transcript.slice(before.length).trim() : transcript.slice(-2000),
    conversationId: conversationId === '' ? null : conversationId,
  }
}
