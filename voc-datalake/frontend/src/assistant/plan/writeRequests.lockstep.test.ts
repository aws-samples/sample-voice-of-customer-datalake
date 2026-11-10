/**
 * LOCKSTEP: a plan step's write is built by the stream Lambda's
 * `buildWriteRequest(tool, args, env)` (`lambda/stream/src/assistant/plan/
 * write-requests.ts`, run by `voc-plan-step`) and must be the SAME request the
 * SPA executor of that tool sends when a card is approved
 * (docs/assistant-plan-mode.md → "Runtime": "a write is built identically by a
 * card and by a plan").
 *
 * The cases are the stream's own (`write-request-fixtures.ts`): one per tool a
 * plan step may name (`PLAN_STEP_WRITE_TOOLS`). Each runs through the SPA
 * executor against a stubbed `fetch` — the lowest seam, so calls made inside
 * `api/client.ts` are seen too — with the SPA state set to the case env
 * (`CASE_ENV`: time window, UI language, date basis, signed-in username). The
 * executor's reads answer with the same state the plan step's preconditions
 * read (`write-preconditions.ts`): the stored scraper an update merges into, no
 * existing scraper / app connector for a create. Its one non-GET request
 * (method, path, query, JSON body) must equal the stream's.
 *
 * Only `edit_id` (a fresh UUID per SPA write, a stable id per plan step) is
 * compared by presence rather than value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { PLAN_STEP_WRITE_TOOLS, buildWriteRequest } from '../../../../lambda/stream/src/assistant/plan/write-requests'
import { CASE_ENV, UPDATE_SCRAPER_CASE, WEB_REVIEWS_CONNECTOR_CASE, WRITE_REQUEST_CASES } from '../../../../lambda/stream/src/assistant/plan/write-request-fixtures'
import { normalizeScrapers } from '../../api/scrapersSchema'
import { useAuthStore } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { getWriteTool } from '../approvals/registry'
import { scraperFingerprint } from '../approvals/scraperSchemas'
import { createShownRecord } from '../approvals/shown'
import type { ShownRecord } from '../approvals/shown'
import { ignoreRejection } from '../../lib/rejections'

const BASE = 'https://api.example.com'
const EDIT_ID = '<edit-id>'

interface Captured { method: string; path: string; query: Record<string, string>; body: unknown }

/** What the SPA executor reads before it writes, and what its card recorded, per tool. */
interface SpaState { reads?: Record<string, unknown>; shown?: Partial<ShownRecord> }

// The SPA reads the raw stored record (and normalises it itself); the stream gets the precondition's normalised `current`.
const STORED_SCRAPER = normalizeScrapers([UPDATE_SCRAPER_CASE.stored])[0]
const SPA_STATE: Readonly<Record<string, SpaState>> = {
  update_scraper: {
    reads: { '/scrapers': { scrapers: [UPDATE_SCRAPER_CASE.stored] } },
    shown: { scraperBase: STORED_SCRAPER === undefined ? undefined : scraperFingerprint(STORED_SCRAPER) },
  },
  create_scraper: { reads: { '/scrapers': { scrapers: [] } } },
  create_app_connector: { reads: { '/integrations/app_reviews_ios/apps': { apps: [] }, '/integrations/web_reviews/apps': { apps: [] } } },
}

const CASES = [...WRITE_REQUEST_CASES, UPDATE_SCRAPER_CASE]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function withEditIdMarked(body: unknown): unknown {
  if (!isRecord(body) || typeof body.edit_id !== 'string') return body
  return { ...body, edit_id: EDIT_ID }
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input
  return new URL(typeof input === 'string' ? input : input.url)
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** Stub `fetch`: GETs answer from the tool's reads, writes are recorded and answered generically. */
function stubFetch(state: SpaState, writes: Captured[]) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET') return Promise.resolve(jsonResponse(state.reads?.[decodeURI(url.pathname)] ?? {}))
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    writes.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body })
    return Promise.resolve(jsonResponse({ success: true }))
  }))
}

async function spaRequests(tool: string, args: Record<string, unknown>): Promise<Captured[]> {
  const writes: Captured[] = []
  const state = SPA_STATE[tool] ?? {}
  stubFetch(state, writes)
  const shown: ShownRecord = {
    ...createShownRecord(),
    job: { days: CASE_ENV.days, responseLanguage: CASE_ENV.responseLanguage ?? 'en' },
    ...state.shown,
  }
  const ctx = { queryClient: new QueryClient(), page: { kind: 'home' as const, path: '/' }, shown, isAdmin: true }
  // A generic answer may not satisfy the executor's response parsing; the request has been sent by then.
  await getWriteTool(tool)?.execute(args, ctx).catch(ignoreRejection)
  return writes.map((write) => ({ ...write, body: withEditIdMarked(write.body) }))
}

function streamRequest(tool: string, args: Record<string, unknown>): Captured {
  const current = tool === UPDATE_SCRAPER_CASE.tool ? UPDATE_SCRAPER_CASE.current : undefined
  const request = buildWriteRequest(tool, args, { ...CASE_ENV, ...(current === undefined ? {} : { current }) })
  return { method: request.method, path: request.path, query: {}, body: withEditIdMarked(request.body) }
}

beforeEach(() => {
  useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: BASE }, dateBasis: CASE_ENV.dateBasis ?? 'imported' }))
  useAuthStore.setState({ user: { username: CASE_ENV.author ?? '', email: 'jane@example.com', groups: ['admins'] } })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('plan write requests', () => {
  it('has one stream case per tool a plan step may name', () => {
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect(CASES.map((c) => c.tool).sort(byName)).toStrictEqual([...PLAN_STEP_WRITE_TOOLS].sort(byName))
  })

  it.each(CASES.map((c) => [c.tool, c.args] as const))('%s: the stream builds the request the SPA executor sends', async (tool, args) => {
    expect(await spaRequests(tool, args)).toStrictEqual([streamRequest(tool, args)])
  })

  it('create_app_connector for a web_reviews page: the same request on both sides', async () => {
    const { tool, args } = WEB_REVIEWS_CONNECTOR_CASE
    expect(await spaRequests(tool, args)).toStrictEqual([streamRequest(tool, args)])
  })
})
