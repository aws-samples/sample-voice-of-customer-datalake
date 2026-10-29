/**
 * @fileoverview The SPA side of the engagement wire contract.
 *
 * `schemas/engagement-wire.json` holds real response bodies of the engagement API, recorded by
 * lambda/api/test/test_engagement_wire_contract.py (which also fails when the backend's shapes
 * drift from it). Here every body goes through the SPA's own normalizer, and the parsed result
 * must be BACKED by the raw body: every field the UI gets is one the backend sent (or one of the
 * few that are absent until something happens), and every scalar the backend sent arrives
 * unchanged (an enum or a number that fell back to its default is a mismatch, not a value).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import wire from '../../../schemas/engagement-wire.json'
import { normalize } from './participantsSchema'
import { createFeatureRequestsApi } from './featureRequestsApi'

/** Absent from the wire until something happens (a null / undefined default is then the truth). */
const ABSENT_UNTIL_SET = new Set(['unsubscribed_at', 'feature_request_id', 'project_id', 'list_id', 'deal', 'contact_email', 'note', 'updated_by', 'updated_at', 'responded_at'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Where `parsed` is not backed by `raw`: `path: reason` lines (empty = fully backed). */
function unbacked(parsed: unknown, raw: unknown, path: string): string[] {
  if (Array.isArray(parsed)) {
    if (!Array.isArray(raw)) return [`${path}: an array the backend did not send`]
    return parsed.flatMap((item, index) => unbacked(item, raw[index], `${path}[${index}]`))
  }
  if (isRecord(parsed)) {
    if (!isRecord(raw)) return [`${path}: an object the backend did not send`]
    return Object.entries(parsed).flatMap(([key, value]) => {
      if (!(key in raw)) return ABSENT_UNTIL_SET.has(key) || value === undefined ? [] : [`${path}.${key}: never sent`]
      return unbacked(value, raw[key], `${path}.${key}`)
    })
  }
  return Object.is(parsed, raw) ? [] : [`${path}: backend ${JSON.stringify(raw)} read as ${JSON.stringify(parsed)}`]
}

const bodies: Record<string, unknown> = wire

function body(name: string): unknown {
  expect(bodies, `fixture entry ${name}`).toHaveProperty(name)
  return bodies[name]
}

/** The body at `key` of a recorded response. */
function field(name: string, key: string): unknown {
  const value = body(name)
  return isRecord(value) ? value[key] : undefined
}

describe('participants responses, parsed by the SPA', () => {
  it.each([
    ['settings_get', (raw: unknown) => normalize.settings(raw), (raw: unknown) => raw],
    ['settings_put', (raw: unknown) => normalize.savedSettings(raw), (raw: unknown) => (isRecord(raw) ? raw['settings'] : raw)],
    ['lists', (raw: unknown) => normalize.lists(raw), (raw: unknown) => (isRecord(raw) ? raw['lists'] : raw)],
    ['list_create', (raw: unknown) => normalize.list(raw), (raw: unknown) => (isRecord(raw) ? raw['list'] : raw)],
    ['list_update', (raw: unknown) => normalize.list(raw), (raw: unknown) => (isRecord(raw) ? raw['list'] : raw)],
    ['list_detail', (raw: unknown) => normalize.listDetail(raw), (raw: unknown) => raw],
    ['list_members_add', (raw: unknown) => normalize.addMembers(raw), (raw: unknown) => raw],
    ['people', (raw: unknown) => normalize.people(raw), (raw: unknown) => (isRecord(raw) ? raw['people'] : raw)],
    ['person_create', (raw: unknown) => normalize.person(raw), (raw: unknown) => (isRecord(raw) ? raw['person'] : raw)],
    ['person_update', (raw: unknown) => normalize.person(raw), (raw: unknown) => (isRecord(raw) ? raw['person'] : raw)],
    ['person_detail', (raw: unknown) => normalize.personDetail(raw), (raw: unknown) => raw],
    ['project_get', (raw: unknown) => normalize.project(raw), (raw: unknown) => raw],
    ['project_link', (raw: unknown) => normalize.projectLink(raw), (raw: unknown) => raw],
    ['asks', (raw: unknown) => normalize.asks(raw), (raw: unknown) => (isRecord(raw) ? raw['asks'] : raw)],
    ['ask_create', (raw: unknown) => normalize.ask(raw), (raw: unknown) => (isRecord(raw) ? raw['ask'] : raw)],
    ['ask_detail', (raw: unknown) => normalize.askDetail(raw), (raw: unknown) => raw],
  ])('%s', (name, parse, rawOf) => {
    const raw = body(name)
    expect(unbacked(parse(raw), rawOf(raw), name)).toStrictEqual([])
  })

  it('the person listing carries the lists column', () => {
    expect(normalize.people(body('people')).some((person) => (person.list_ids ?? []).length > 0)).toBe(true)
  })

  it('a project invite reports its refusals', () => {
    expect(normalize.projectLink(body('project_link')).rejected).toStrictEqual([{ email: 'nope', reason: 'invalid_email' }])
  })
})

describe('feature-request responses, parsed by the SPA', () => {
  /** The real API module over a transport that answers the recorded body. */
  const apiAnswering = (name: string) => createFeatureRequestsApi(<T>() => Promise.resolve(z.custom<T>(() => true).parse(bodies[name])))

  it.each([
    ['fr_list', () => apiAnswering('fr_list').listRequests(), (raw: unknown) => raw],
    ['fr_detail', () => apiAnswering('fr_detail').getRequest('fr_1'), (raw: unknown) => raw],
    ['fr_create', () => apiAnswering('fr_create').createRequest({ title: '', description: '', name: '', fields: {} }), (raw: unknown) => raw],
    ['fr_update', () => apiAnswering('fr_update').updateRequest('fr_1', {}), (raw: unknown) => (isRecord(raw) ? raw['request'] : raw)],
    ['fr_status', () => apiAnswering('fr_status').setStatus('fr_1', 'planned'), (raw: unknown) => (isRecord(raw) ? raw['request'] : raw)],
    ['fr_support_create', () => apiAnswering('fr_support_create').addSupport('fr_1', { name: '', fields: {} }), (raw: unknown) => raw],
    ['fr_support_update', () => apiAnswering('fr_support_update').updateSupport('fr_1', 'sup_1', { name: '', fields: {} }), (raw: unknown) => (isRecord(raw) ? raw['request'] : raw)],
    ['fr_support_delete', () => apiAnswering('fr_support_delete').deleteSupport('fr_1', 'sup_1'), (raw: unknown) => (isRecord(raw) ? raw['request'] : raw)],
    ['fr_promote', () => apiAnswering('fr_promote').promote('fr_1', 'proj-public'), (raw: unknown) => raw],
  ])('%s', async (name, run, rawOf) => {
    expect(unbacked(await run(), rawOf(body(name)), name)).toStrictEqual([])
  })

  it('the viewer of a board-pool caller is a board user, not an admin', async () => {
    expect((await apiAnswering('fr_list').listRequests()).viewer).toMatchObject({ pool: 'board', is_admin: false })
  })
})

describe('the error envelope', () => {
  it('is {success: false, error} — the key api/client.ts reads after `message`', () => {
    const raw = body('error')
    expect(isRecord(raw) ? new Set(Object.keys(raw)) : null).toStrictEqual(new Set(['error', 'success']))
    expect([field('error', 'success'), typeof field('error', 'error')]).toStrictEqual([false, 'string'])
  })
})
