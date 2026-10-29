/**
 * @fileoverview Board fixtures for the Boards section specs (wire shape of `/feature-requests/boards*`).
 */
import { ApiError } from '../../../lib/errors'
import { SETTINGS_VIEW } from '../../Participants/participants-fixtures'
import type { RouteHandler } from '@test/fetchApiRoutes'

export const SALES_BOARD = {
  board_id: 'brd_sales', slug: 'sales-feature-requests', name: 'Sales feature requests', description: '',
  template: 'sales',
  fields: {
    request: { customer: { enabled: true, required: true }, impact: { enabled: true, required: true } },
    support: { customer: { enabled: true, required: false } },
  },
  statuses: [{ key: 'new', label: 'New' }, { key: 'planned', label: 'Planned' }, { key: 'shipped', label: 'Shipped' }],
  audience: { mode: 'company', domains: [], emails: [] },
  archived: false, request_count: 2, share_url: 'https://voc.example.com/board/sales-feature-requests',
  updated_at: '2026-10-20T00:00:00Z',
}

export const BETA_BOARD = {
  ...SALES_BOARD, board_id: 'brd_00000001', slug: 'beta-feedback', name: 'Beta feedback', template: 'beta',
  fields: { request: {}, support: {} }, statuses: [{ key: 'new', label: 'New' }, { key: 'fixed', label: 'Fixed' }],
  audience: { mode: 'list', domains: ['acme.example'], emails: ['tester@example.com'] },
  archived: true, request_count: 0, share_url: 'https://voc.example.com/board/beta-feedback',
}

/** A refusal as `fetchApi` raises it: the server's reason code is the message. */
export const refusal = (status: number, reason: string) => () => { throw new ApiError(status, reason) }

export function boardRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    'GET /participants/settings': () => SETTINGS_VIEW,
    'GET /feature-requests/boards': () => ({ boards: [SALES_BOARD, BETA_BOARD] }),
    'GET /feature-requests/boards/brd_sales': () => ({ board: SALES_BOARD }),
    'GET /feature-requests/boards/brd_00000001': () => ({ board: BETA_BOARD }),
    ...overrides,
  }
}
