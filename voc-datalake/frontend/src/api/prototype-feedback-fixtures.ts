/**
 * @fileoverview The feedback route's answer as the contract shapes it
 * (docs/prototype-builder.md Part 3), for the specs.
 */

const PIN = {
  pin_id: 'pin_1', document_id: 'doc_v3', version: 3, status: 'open', created_at: '2026-11-13T10:00:00+00:00',
  addressed_by: null, flagged: false, text: 'The total is hidden on phones',
  replies: [{ by: 'sub-1', name: 'Ana', text: 'Seen', at: '2026-11-13T11:00:00+00:00' }],
}

export const FEEDBACK_ANSWER = {
  document_id: 'doc_v3',
  versions_read: [{ document_id: 'doc_v3', version: 3 }],
  partial: false,
  cut: [],
  older_versions_unread: 0,
  pin_count: 2,
  groups: [{
    route: '/checkout',
    route_unsafe: false,
    items: [{
      item_id: 'pin_1', pin_ids: ['pin_1', 'pin_2'], count: 2, flagged: false, text: 'The total is hidden on phones',
      anchor: { route: '/checkout', selector: '#total', text_snippet: 'Total' }, unsafe_fields: [],
      first_at: '2026-11-13T10:00:00+00:00',
      pins: [PIN, { ...PIN, pin_id: 'pin_2', addressed_by: 'doc_v4', status: 'addressed' }],
    }],
  }],
}
