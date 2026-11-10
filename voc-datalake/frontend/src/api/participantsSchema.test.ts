/**
 * @fileoverview The participants wire normalizers: sparse records degrade to defaults,
 * id-less rows are dropped one by one, and a response missing its record is an error.
 */
import { describe, expect, it } from 'vitest'
import { normalize } from './participantsSchema'

describe('participants wire normalizers', () => {
  it('keeps the good lists and drops an id-less one, defaulting sparse fields', () => {
    const lists = normalize.lists({ lists: [{ list_id: 'lst_1', name: 'Beta', kind: 'beta', member_count: '3' }, { name: 'no id' }, 'junk'] })
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({ list_id: 'lst_1', name: 'Beta', kind: 'beta', member_count: 3, description: '', feature_request_id: null })
  })

  it('reads an unknown list kind as custom and a missing list array as none', () => {
    expect(normalize.lists({ lists: [{ list_id: 'l', kind: 'vip' }] })[0]?.kind).toBe('custom')
    expect(normalize.lists(null)).toStrictEqual([])
  })

  it('reads a sparse person as active with empty fields, and keeps list ids only when sent', () => {
    const [bare, withLists] = normalize.people({ people: [{ person_id: 'p1', email: 'a@example.com' }, { person_id: 'p2', list_ids: ['l1', '', 4] }] })
    expect(bare).toMatchObject({ status: 'active', name: '', tags: [], origin: 'manual', unsubscribed_at: null })
    expect(bare?.list_ids).toBeUndefined()
    expect(withLists?.list_ids).toStrictEqual(['l1'])
  })

  it('fills missing ask counts with zeros and an unreadable link with null', () => {
    const ask = normalize.ask({ ask: { ask_id: 'ask_1', subject: 'Hi', counts: { sent: 2 }, link: { kind: 'ftp' } } })
    expect(ask.counts).toStrictEqual({ recipients: 0, sent: 2, failed: 0, skipped: 0, responded: 0 })
    expect(ask.link).toBeNull()
    expect(ask.status).toBe('queued')
  })

  it('keeps an erased recipient with a null email and name', () => {
    const detail = normalize.askDetail({ ask: { ask_id: 'a' }, recipients: [{ person_id: 'p', email: null, status: 'failed', error: 'bounced' }] })
    expect(detail.recipients[0]).toMatchObject({ email: null, name: null, status: 'failed', error: 'bounced' })
  })

  it('treats a response without its record as an error, not a blank record', () => {
    expect(() => normalize.person({})).toThrow(/person/)
    expect(() => normalize.listDetail({ list: { name: 'x' }, members: [] })).toThrow(/list/)
  })

  it('defaults the engagement settings and says email is off when the wire is empty', () => {
    expect(normalize.settings(undefined)).toStrictEqual({
      settings: { company_domains: [], allow_external_people: true, daily_send_cap: 500, sender_name: '', updated_at: null, updated_by: null },
      email_enabled: false, board_enabled: false, board_url: '',
    })
  })

  it('rejects an out-of-range send cap back to the default', () => {
    expect(normalize.settings({ settings: { daily_send_cap: 99999 } }).settings.daily_send_cap).toBe(500)
  })

  it('reports rejected addresses with their reason', () => {
    expect(normalize.addMembers({ added: 1, rejected: [{ email: 'x@other.example', reason: 'external_not_allowed' }] })).toStrictEqual({
      added: 1, already: 0, created: 0, rejected: [{ email: 'x@other.example', reason: 'external_not_allowed' }],
    })
  })

  it('reads the project participants with a zero reach when absent', () => {
    expect(normalize.project({ lists: [], people: [{ person_id: 'p' }] })).toMatchObject({ reach: 0, people: [{ person_id: 'p' }] })
  })
})
