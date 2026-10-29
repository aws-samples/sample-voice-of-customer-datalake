/**
 * @fileoverview The feature-request board API (`/feature-requests/*`, docs/feature-requests.md).
 *
 * One client for two sessions. App users reach the board with their normal session (the in-app
 * page, and `/board` when they are signed in to the app); board-pool users reach it with the board
 * session. So the client is a FACTORY over a transport rather than a module bound to `fetchApi`:
 *
 * - {@link appTransport} is `fetchApi` itself (its 401 refresh-and-retry, its end-of-session redirect).
 * - {@link boardTransport} sends a board token, refreshes it once on 401, and reports a non-OK
 *   response with `fetchApi`'s own `apiErrorFor` — it cannot go through `fetchApi`, whose 401 path
 *   signs the APP session out and sends the visitor to `/login`, a page a board user cannot use.
 *
 * Every response is parsed with a lenient zod schema: one malformed row costs exactly itself.
 *
 * @module api/featureRequestsApi
 */
import { del, post, put } from './requestKit'
import { z } from 'zod'
import { AuthError } from '../lib/errors'
import { isTrustedOrigin } from '../lib/trustedOrigins'
import { getBaseUrl } from './baseUrl'
import { apiErrorFor, fetchApi as appFetchApi } from './client'
import { lenientText, optionalText, parsedList } from './schemaList'
import { toOptionalFiniteNumber } from './lenientFields'
import { IMPACT_CHOICES } from './boardFields'
import { boardSchema, count, deleteBoardStepSchema, fieldValuesSchema } from './featureBoardsSchema'
import type { BoardPatch, DeleteBoardStep, FieldValues, NewBoardInput } from './featureBoardsSchema'
import type { FetchApi } from './requestKit'

export type SupportImpact = typeof IMPACT_CHOICES[number]

/** A positive number, or undefined (sent only by the templates that total it). */
const optionalFigure = z.unknown().optional().transform((value) => {
  const n = toOptionalFiniteNumber(value)
  return n !== undefined && n >= 0 ? n : undefined
})

const totalsSchema = z.object({
  supporters: count,
  customers: count,
  committed_usd: count,
  at_risk_usd: count,
  /** Service boards: people affected (the report's `affected_count`, at least 1, plus every other supporter). */
  affected: optionalFigure,
  /** Beta boards: the average `rating` (1–5); absent while nobody rated. */
  avg_rating: optionalFigure,
}).catch({ supporters: 0, customers: 0, committed_usd: 0, at_risk_usd: 0, affected: undefined, avg_rating: undefined })

const requestSchema = z.object({
  request_id: z.string().min(1),
  title: lenientText,
  description: lenientText,
  // Any key: the board decides whether it knows it (boardStatusOf reads an unknown one as the
  // initial, so the request is offered as untriaged instead of hidden behind a filter).
  status: z.string().min(1).catch('new'),
  reporter_email: lenientText,
  reporter_name: lenientText,
  created_at: lenientText,
  updated_at: lenientText,
  totals: totalsSchema,
  project_id: optionalText,
  list_id: optionalText,
  /** Absent on a pre-boards request: it belongs to the seeded board. */
  board_id: optionalText,
  fields: fieldValuesSchema,
})
export type FeatureRequest = z.infer<typeof requestSchema>

const supportSchema = z.object({
  support_id: z.string().min(1),
  email: lenientText,
  name: lenientText,
  customer: lenientText,
  deal: optionalText,
  impact: z.enum(IMPACT_CHOICES).catch('none'),
  amount_usd: count,
  contact_email: optionalText,
  note: optionalText,
  is_reporter: z.boolean().catch(false),
  created_at: lenientText,
  updated_at: lenientText,
  fields: fieldValuesSchema,
})
export type FeatureSupport = z.infer<typeof supportSchema>

const viewerSchema = z.object({
  email: lenientText,
  name: lenientText,
  // Fail closed: a viewer the client cannot read is never an admin and never an app user.
  is_admin: z.boolean().catch(false),
  pool: z.enum(['app', 'board']).catch('board'),
}).catch({ email: '', name: '', is_admin: false, pool: 'board' })
export type BoardViewer = z.infer<typeof viewerSchema>

const listResponseSchema = z.object({
  requests: parsedList(requestSchema),
  /** The board listed; undefined from a pre-boards API (the client then shows the seeded board). */
  board: boardSchema.optional().catch(undefined),
  viewer: viewerSchema,
})

const boardsResponseSchema = z.object({
  boards: parsedList(boardSchema),
  viewer: viewerSchema,
})

const boardResponseSchema = z.object({ board: boardSchema })

const detailResponseSchema = z.object({
  request: requestSchema,
  supports: parsedList(supportSchema),
})

const requestResponseSchema = z.object({ request: requestSchema })

const supportResponseSchema = z.object({ support: supportSchema, request: requestSchema })

const promoteResponseSchema = z.object({
  request: requestSchema,
  list: z.object({ list_id: lenientText, name: lenientText }).catch({ list_id: '', name: '' }),
  added: count,
  skipped: parsedList(z.object({ email: lenientText, reason: lenientText })),
})
export type PromoteResult = z.infer<typeof promoteResponseSchema>

/**
 * What a supporter states: the body of a +1 (and, with title/description, of a new request). Every
 * value of the board's enabled fields travels in `fields` (api/boardFields.ts); the API checks it
 * strictly against the board, and a +1 of the reporter is made from the request's values.
 */
export interface SupportInput {
  readonly name: string
  readonly fields: FieldValues
}

export interface NewRequestInput extends SupportInput {
  readonly title: string
  readonly description: string
  /** The board's slug or id; omitted = the seeded board. */
  readonly board?: string
}

export function normalizeRequestList(raw: unknown): z.infer<typeof listResponseSchema> {
  const parsed = listResponseSchema.safeParse(raw)
  return parsed.success ? parsed.data : { requests: [], board: undefined, viewer: viewerSchema.parse(undefined) }
}

function normalizeBoardList(raw: unknown): z.infer<typeof boardsResponseSchema> {
  const parsed = boardsResponseSchema.safeParse(raw)
  return parsed.success ? parsed.data : { boards: [], viewer: viewerSchema.parse(undefined) }
}

export function normalizeRequestDetail(raw: unknown): z.infer<typeof detailResponseSchema> {
  return detailResponseSchema.parse(raw)
}

/**
 * The board transport for a board-pool session. `getToken(true)` must return a refreshed token
 * (or null when the session is gone); the token is only ever sent to a trusted API origin.
 */
export function boardTransport(getToken: (forceRefresh: boolean) => Promise<string | null>): FetchApi {
  const send = async (url: string, options: RequestInit | undefined, forceRefresh: boolean): Promise<Response> => {
    const token = isTrustedOrigin(url) ? await getToken(forceRefresh) : null
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token !== null && token !== '') headers['Authorization'] = token
    return fetch(url, { ...options, headers })
  }
  return async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
    const url = `${getBaseUrl()}${endpoint}`
    const first = await send(url, options, false)
    const response = first.status === 401 ? await send(url, options, true) : first
    if (response.status === 401) throw new AuthError()
    if (!response.ok) throw await apiErrorFor(response)
    const body: unknown = await response.json()
    return z.custom<T>(() => true).parse(body)
  }
}

/** The app session's transport. */
// Resolved per call, not at import: a module that mocks `./client` without `fetchApi` (a page test
// that never reaches a board) can still import this file.
export const appTransport: FetchApi = (endpoint, options) => appFetchApi(endpoint, options)

function requestPath(requestId: string): string {
  return `/feature-requests/${encodeURIComponent(requestId)}`
}

function boardPath(boardRef: string): string {
  return `/feature-requests/boards/${encodeURIComponent(boardRef)}`
}

/** A board's DELETE path; `withRequests` asks the API to delete its requests too. */
function boardDeletePath(boardId: string, options: DeleteBoardOptions): string {
  return options.withRequests === true ? `${boardPath(boardId)}?${new URLSearchParams({ with_requests: 'true' }).toString()}` : boardPath(boardId)
}

export interface DeleteBoardOptions {
  /** Delete the board's requests (and every +1 on them) with it. */
  readonly withRequests?: boolean
}

/** `/feature-requests`, filtered to one board when `boardRef` is given. */
function requestsPath(boardRef: string | undefined): string {
  return boardRef === undefined ? '/feature-requests' : `/feature-requests?${new URLSearchParams({ board: boardRef }).toString()}`
}

function supportPath(requestId: string, supportId: string): string {
  return `${requestPath(requestId)}/supports/${encodeURIComponent(supportId)}`
}

/**
 * The board API over one transport. The local is named `fetchApi` on purpose: the dev-mock gate
 * (`scripts/check-mock-coverage.mjs`) finds call sites by that name, so every route below is gated.
 */
export function createFeatureRequestsApi(transport: FetchApi) {
  const fetchApi = (endpoint: string, init?: RequestInit) => transport<unknown>(endpoint, init)
  return {
    listBoards: async () => normalizeBoardList(await fetchApi('/feature-requests/boards')),

    getBoard: async (boardRef: string) => boardResponseSchema.parse(await fetchApi(boardPath(boardRef))).board,

    createBoard: async (input: NewBoardInput) =>
      boardResponseSchema.parse(await fetchApi('/feature-requests/boards', post(input))).board,

    updateBoard: async (boardId: string, patch: BoardPatch) =>
      boardResponseSchema.parse(await fetchApi(boardPath(boardId), put(patch))).board,

    /**
     * Delete a board (admin). Plain: only an empty board (409 `board_not_empty` otherwise).
     * `withRequests`: one bounded step that deletes a page of its requests (archiving the board on
     * the first step) and the board once none remain; repeat until `done` (`deleteBoardFully`).
     */
    deleteBoard: async (boardId: string, options: DeleteBoardOptions = {}): Promise<DeleteBoardStep> =>
      deleteBoardStepSchema.parse(await fetchApi(boardDeletePath(boardId, options), del())),

    /** One board's requests (`boardRef` = slug or id); omitted = the seeded board, as before boards. */
    listRequests: async (boardRef?: string) => normalizeRequestList(await fetchApi(requestsPath(boardRef))),

    getRequest: async (requestId: string) => normalizeRequestDetail(await fetchApi(requestPath(requestId))),

    createRequest: async (input: NewRequestInput) =>
      normalizeRequestDetail(await fetchApi('/feature-requests', post(input))),

    updateRequest: async (requestId: string, input: { title?: string; description?: string }) =>
      requestResponseSchema.parse(await fetchApi(requestPath(requestId), put(input))).request,

    /** `status` = one of the request's board's status keys. */
    setStatus: async (requestId: string, status: string) =>
      requestResponseSchema.parse(await fetchApi(`${requestPath(requestId)}/status`, put({ status }))).request,

    deleteRequest: async (requestId: string): Promise<void> => {
      await fetchApi(requestPath(requestId), del())
    },

    addSupport: async (requestId: string, input: SupportInput) =>
      supportResponseSchema.parse(await fetchApi(`${requestPath(requestId)}/supports`, post(input))),

    updateSupport: async (requestId: string, supportId: string, input: SupportInput) =>
      requestResponseSchema.parse(await fetchApi(supportPath(requestId, supportId), put(input))).request,

    deleteSupport: async (requestId: string, supportId: string) =>
      requestResponseSchema.parse(await fetchApi(supportPath(requestId, supportId), del())).request,

    promote: async (requestId: string, projectId: string) =>
      promoteResponseSchema.parse(await fetchApi(`${requestPath(requestId)}/promote`, post({ project_id: projectId }))),
  }
}

export type FeatureRequestsApi = ReturnType<typeof createFeatureRequestsApi>

/** The board API of the app session (the in-app board pages and Administration → Boards). */
export const appFeatureRequestsApi: FeatureRequestsApi = createFeatureRequestsApi(appTransport)

/**
 * The board cache's keys. Every key carries the hosting session (`app` | `board`), so an app
 * session and a board session in one tab never read each other's answers. Shared with the
 * breadcrumbs, which READ a board's name from the page's own list entry (never fetch it).
 */
export const featureRequestKeys = {
  root: (session: string) => ['feature-requests', session] as const,
  boards: (session: string) => ['feature-requests', session, 'boards'] as const,
  /** One board's configuration (`GET /feature-requests/boards/{ref}`), as Administration → Boards edits it. */
  board: (session: string, boardRef: string) => ['feature-requests', session, 'board', boardRef] as const,
  /** One board's request list (`{requests, board, viewer}`), by the slug or id in the URL. */
  list: (session: string, boardRef: string) => ['feature-requests', session, 'list', boardRef] as const,
  detail: (session: string, requestId: string) => ['feature-requests', session, 'detail', requestId] as const,
}
