/**
 * The default run's assistant regression checks (verify F1 and s1 F3, 2.15.00):
 * - a run logs no console error, and no `/chat/conversations` save is refused
 *   409 (the SPA's pre-run save used to race the stream Lambda's run-start write);
 * - a reload mid-answer comes back "Still generating…" and then shows the answer
 *   the SERVER finished (`GET /chat/conversations/{id}`, `runStatus: finished`).
 *
 * The pure helpers read a stored session (`chat_handler.py` GET: AG-UI messages
 * `{ id, role, content }` plus `runStatus`) without trusting its shape.
 */
import { expect, type Page, type Response } from '@playwright/test'
import { apiUrl } from './env'
import { isRecord } from './guards'

/** `chat_handler.py` RUN_STATUSES. */
const RUN_STATUSES = ['running', 'finished', 'failed', 'interrupted'] as const
type RunStatus = (typeof RUN_STATUSES)[number]
const isRunStatus = (value: unknown): value is RunStatus => RUN_STATUSES.some((s) => s === value)

/** `runStatus` of a stored session, or null when absent / not one of the four. */
export function runStatusOf(body: unknown): RunStatus | null {
  const status = isRecord(body) ? body['runStatus'] : undefined
  return isRunStatus(status) ? status : null
}

/** The text of the last assistant message of a stored session ('' when there is none). */
export function lastAssistantText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body['messages'])) return ''
  const answers = body['messages'].filter(isRecord)
    .filter((m) => m['role'] === 'assistant' && typeof m['content'] === 'string' && m['content'] !== '')
  const last = answers.at(-1)?.['content']
  return typeof last === 'string' ? last : ''
}

/**
 * Markdown reduced to the words a reader sees, whitespace-collapsed: what the
 * rendered transcript can be compared with (markup, links' URLs and table pipes gone).
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|~]/g, ' ')
    .replace(/^\s*[-+]\s+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first `n` words of `text` (after `plainText`), for a "the answer is shown" check. */
export function headWords(text: string, n: number): string {
  return plainText(text).split(' ').slice(0, n).join(' ')
}

export interface AssistantHealth {
  /** `console.error` lines (and browser-logged failed loads) seen since `watch`. */
  readonly consoleErrors: string[]
  /** `METHOD path -> 409` for every conversation call the server refused. */
  readonly conflicts: string[]
  stop: () => void
}

/**
 * Stops watching and asserts the run was clean. A failing step skips this, which is
 * fine: the per-test page, and its listeners, close with the test.
 */
export function expectHealthy(health: AssistantHealth, during: string): void {
  health.stop()
  expect(health.conflicts, `no /chat/conversations call refused 409 ${during}`).toEqual([])
  expect(health.consoleErrors, `no console error ${during}`).toEqual([])
}

const isConversationCall = (response: Response): boolean => {
  const url = new URL(response.url())
  return url.origin === new URL(apiUrl()).origin && /\/chat\/conversations(\/|$)/.test(url.pathname)
}

/** Watches `page` for what an assistant run must never produce (survives reloads: page-level listeners). */
export function watchAssistantHealth(page: Page): AssistantHealth {
  const consoleErrors: string[] = []
  const conflicts: string[] = []
  const onConsole = (message: { type: () => string; text: () => string }): void => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300))
  }
  const onResponse = (response: Response): void => {
    if (response.status() === 409 && isConversationCall(response)) {
      conflicts.push(`${response.request().method()} ${new URL(response.url()).pathname} -> 409`)
    }
  }
  page.on('console', onConsole)
  page.on('response', onResponse)
  return {
    consoleErrors,
    conflicts,
    stop: () => {
      page.off('console', onConsole)
      page.off('response', onResponse)
    },
  }
}
