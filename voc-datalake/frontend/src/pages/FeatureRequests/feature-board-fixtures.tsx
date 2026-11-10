/**
 * Test harness for the shared board components: an in-memory board API (every method a spy), board
 * fixtures per template, and a renderer that hosts `FeatureBoard` the way a page does.
 */
import { vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { SEEDED_BOARD } from '../../api/featureBoardsSchema'
import { TEMPLATE_DEFAULTS } from '../../api/boardFields'
import FeatureBoard from './FeatureBoard'
import { SearchProbe } from './search-probe-fixtures'
import { BoardHostContext } from './boardContext'
import type { BoardTemplate } from '../../api/boardFields'
import type { FeatureBoard as Board } from '../../api/featureBoardsSchema'
import type {
  BoardViewer, FeatureRequest, FeatureRequestsApi, FeatureSupport, NewRequestInput, SupportInput,
} from '../../api/featureRequestsApi'
import type { BoardHost } from './boardContext'

export const ADMIN: BoardViewer = { email: 'admin@example.com', name: 'Admin Demo', is_admin: true, pool: 'app' }
export const APP_USER: BoardViewer = { email: 'rui.costa@example.com', name: 'Rui Costa', is_admin: false, pool: 'app' }
export const BOARD_USER: BoardViewer = { email: 'sam.seller@example.com', name: '', is_admin: false, pool: 'board' }

/** A board of `template` with its defaults, shared at `/board/<slug>`. */
export function fixtureBoard(template: BoardTemplate, fields: Partial<Board> = {}): Board {
  const slug = fields.slug ?? `${template}-board`
  return {
    ...SEEDED_BOARD,
    board_id: `brd_${template}`, slug, name: `${template} board`, template,
    fields: TEMPLATE_DEFAULTS[template].fields, statuses: TEMPLATE_DEFAULTS[template].statuses,
    share_url: `https://voc.example.com/board/${slug}`, request_count: 0,
    ...fields,
  }
}

export function fixtureRequest(id: string, fields: Partial<Omit<FeatureRequest, 'totals'>> & { totals?: Partial<FeatureRequest['totals']> } = {}): FeatureRequest {
  const { totals, ...rest } = fields
  return {
    request_id: id, title: `Request ${id}`, description: 'What the customer needs', status: 'new',
    reporter_email: 'dana.lee@example.com', reporter_name: 'Dana Lee', created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z', project_id: undefined, list_id: undefined, board_id: undefined, fields: undefined,
    ...rest,
    totals: { supporters: 1, customers: 1, committed_usd: 0, at_risk_usd: 0, affected: undefined, avg_rating: undefined, ...totals },
  }
}

export function fixtureSupport(id: string, fields: Partial<FeatureSupport> = {}): FeatureSupport {
  return {
    support_id: id, email: 'dana.lee@example.com', name: 'Dana Lee', customer: 'Acme', deal: undefined,
    impact: 'committed', amount_usd: 50000, contact_email: undefined, note: undefined, is_reporter: false,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', fields: undefined,
    ...fields,
  }
}

export interface FakeBoard {
  readonly api: FeatureRequestsApi
  readonly requests: FeatureRequest[]
  readonly supports: Map<string, FeatureSupport[]>
}

/** Where the fake reads its board(s): the board its requests list answers, and the boards listing. */
export interface FakeBoards {
  readonly board?: Board
  readonly boards?: readonly Board[]
}

/** A board API over in-memory rows, answering as the given viewer. */
export function fakeBoard(viewer: BoardViewer, requests: FeatureRequest[], supports: Record<string, FeatureSupport[]> = {}, setup: FakeBoards = {}): FakeBoard {
  const rows = new Map(Object.entries(supports))
  const boards = setup.boards ?? (setup.board ? [setup.board] : [SEEDED_BOARD])
  const find = (requestId: string) => {
    const found = requests.find((item) => item.request_id === requestId)
    if (!found) throw new Error('not found')
    return found
  }
  const api: FeatureRequestsApi = {
    listBoards: vi.fn(() => Promise.resolve({ boards: [...boards], viewer })),
    getBoard: vi.fn((ref: string) => Promise.resolve(boards.find((board) => board.slug === ref || board.board_id === ref) ?? SEEDED_BOARD)),
    createBoard: vi.fn(() => Promise.resolve(SEEDED_BOARD)),
    updateBoard: vi.fn(() => Promise.resolve(SEEDED_BOARD)),
    deleteBoard: vi.fn(() => Promise.resolve({ done: true, deleted: 0, remaining: 0 })),
    listRequests: vi.fn(() => Promise.resolve({ requests: [...requests], board: setup.board, viewer })),
    getRequest: vi.fn((requestId: string) => Promise.resolve({ request: find(requestId), supports: rows.get(requestId) ?? [] })),
    createRequest: vi.fn((input: NewRequestInput) => {
      const created = fixtureRequest('fr_new', { title: input.title, description: input.description })
      requests.push(created)
      return Promise.resolve({ request: created, supports: [] })
    }),
    updateRequest: vi.fn((requestId: string) => Promise.resolve(find(requestId))),
    setStatus: vi.fn((requestId: string, status: string) => Promise.resolve({ ...find(requestId), status })),
    deleteRequest: vi.fn((requestId: string) => {
      requests.splice(requests.indexOf(find(requestId)), 1)
      return Promise.resolve()
    }),
    addSupport: vi.fn((requestId: string, input: SupportInput) => {
      const { customer, impact, amount_usd: amount } = input.fields
      const support = fixtureSupport('sup_new', {
        name: input.name, email: viewer.email, fields: input.fields,
        customer: typeof customer === 'string' ? customer : '',
        impact: impact === 'committed' || impact === 'at_risk' ? impact : 'none',
        amount_usd: typeof amount === 'number' ? amount : 0,
      })
      rows.set(requestId, [...(rows.get(requestId) ?? []), support])
      return Promise.resolve({ support, request: find(requestId) })
    }),
    updateSupport: vi.fn((requestId: string) => Promise.resolve(find(requestId))),
    deleteSupport: vi.fn((requestId: string) => Promise.resolve(find(requestId))),
    promote: vi.fn((requestId: string, projectId: string) => Promise.resolve({
      request: { ...find(requestId), project_id: projectId, status: 'planned' },
      list: { list_id: 'lst_1', name: `Requests: ${find(requestId).title}` },
      added: 2,
      skipped: [{ email: 'it-lead@acme.example', reason: 'external_not_allowed' }],
    })),
  }
  return { api, requests, supports: rows }
}

/** `FeatureBoard` (board `boardRef`) hosted with `api`, at `entry` (e.g. `/feature-requests/x?request=fr_1`). */
export function renderBoard(api: FeatureRequestsApi, entry = '/feature-requests/sales-feature-requests', session: BoardHost['session'] = 'app', boardRef = 'sales-feature-requests') {
  const host: BoardHost = { api, basePath: session === 'app' ? '/feature-requests' : '/board', session }
  return renderWithQueryClient(
    <MemoryRouter initialEntries={[entry]}>
      <BoardHostContext.Provider value={host}>
        <FeatureBoard boardRef={boardRef} notFound={<p>No such board</p>} />
      </BoardHostContext.Provider>
      <SearchProbe />
    </MemoryRouter>,
  )
}
