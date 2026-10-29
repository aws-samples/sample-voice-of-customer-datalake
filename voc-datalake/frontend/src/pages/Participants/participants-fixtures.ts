/**
 * @fileoverview Wire records and a routed API for the participants page specs (fictional
 * names: Example Air, Acme).
 */
import type { RouteHandler } from '@test/fetchApiRoutes'

export const LIST_STAFF = { list_id: 'lst_staff', name: 'Example Air employees', kind: 'employees', member_count: 2, description: 'Colleagues' }
export const LIST_BETA = { list_id: 'lst_beta', name: 'Acme beta customers', kind: 'beta', member_count: 1, description: '' }

export const ANA = { person_id: 'per_ana', email: 'ana.lopez@example.com', name: 'Ana Lopez', company: 'Example Air', status: 'active', list_ids: ['lst_staff'] }
const DEV = { person_id: 'per_dev', email: 'dev.shah@acme.example', name: 'Dev Shah', company: 'Acme', status: 'unsubscribed', list_ids: ['lst_beta'] }

export const SEED_ASK = {
  ask_id: 'ask_1', project_id: 'proj_1', subject: 'Tell us about the booking flow', message: 'Two minutes, please.',
  link: { kind: 'url', url: 'https://example.com/survey' }, status: 'sent', created_at: '2026-10-20T10:00:00Z',
  counts: { recipients: 3, sent: 1, failed: 1, skipped: 1, responded: 1 },
}

export const SETTINGS_VIEW = {
  settings: { company_domains: ['example.com'], allow_external_people: true, daily_send_cap: 500, sender_name: 'Example Air', updated_at: '2026-10-01T00:00:00Z' },
  email_enabled: true, board_enabled: true, board_url: 'https://voc.example.com/board',
}

/** Every read the page makes, answered from the fixtures; override per test. */
export function participantRoutes(overrides: Record<string, RouteHandler> = {}): Record<string, RouteHandler> {
  return {
    'GET /participants/lists': () => ({ lists: [LIST_STAFF, LIST_BETA] }),
    'GET /participants/lists/lst_staff': () => ({ list: LIST_STAFF, members: [ANA] }),
    'GET /participants/lists/lst_beta': () => ({ list: LIST_BETA, members: [DEV] }),
    'GET /participants/people': () => ({ people: [ANA, DEV] }),
    'GET /participants/people/per_ana': () => ({
      person: ANA, lists: [LIST_STAFF], asks: [{ ask_id: 'ask_1', subject: 'Tell us about the booking flow', status: 'responded', sent_at: '2026-10-20T10:00:00Z' }],
    }),
    'GET /participants/asks': () => ({ asks: [SEED_ASK] }),
    'GET /participants/asks/ask_1': () => ({
      ask: SEED_ASK,
      recipients: [
        { person_id: 'per_ana', email: ANA.email, name: ANA.name, status: 'responded', sent_at: '2026-10-20T10:00:00Z', responded_at: '2026-10-21T10:00:00Z' },
        { person_id: 'per_dev', email: DEV.email, name: DEV.name, status: 'skipped_unsubscribed' },
        { person_id: 'per_gone', email: null, name: null, status: 'failed', error: 'bounced' },
      ],
    }),
    'GET /participants/settings': () => SETTINGS_VIEW,
    'GET /feedback-forms': () => ({ forms: [{ form_id: 'form_1', name: 'Website Feedback', enabled: true }] }),
    ...overrides,
  }
}
