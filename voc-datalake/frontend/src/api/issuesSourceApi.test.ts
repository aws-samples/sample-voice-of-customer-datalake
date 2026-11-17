/**
 * @fileoverview The GitHub Issues source as the connections drive it (api/issuesSourceApi.ts, 7.50.02): its two calls
 * are the deployment's (sent without `X-Workspace-Id`, inside a workspace too), the switch's body is `{read}`, and the
 * normalisers read what they do not know as nothing said: an unknown reason is a plain "not read", an unknown label
 * none, a connection without its id is left out, an answer without its connections is an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { issuesSourceApi, parseIssuesFollow, parseIssuesSource } = await import('./issuesSourceApi')

const entry = (fields: Record<string, unknown> = {}) => ({
  connection_id: 'billing-api', repository: 'example-org/billing-api', read: true, reading: true, reason: null,
  label: 'created', ...fields,
})
const VIEW = {
  deployed: true, signs_in: 'app', app_id: '271828', repositories: ['example-org/billing-api'],
  managed: ['example-org/billing-api'], schedule: 'on', label: 'voc-agent', connections: [entry()],
}
const PATH = '/agents/engineering/issues-source'
const SWITCH = '/agents/engineering/connections/billing-api/issues'

beforeEach(() => { resetFetchApi() })

describe('the calls', () => {
  it('read the view and set a connection\'s switch, both in the deployment\'s scope (no X-Workspace-Id)', async () => {
    routeFetchApi({ [`GET ${PATH}`]: () => VIEW, [`PUT ${SWITCH}`]: () => ({ ...VIEW, connections: [entry({ read: false, reading: false, reason: 'off' })] }) })
    expect((await issuesSourceApi.get()).connections).toStrictEqual([entry()])
    const answer = await issuesSourceApi.setRead('billing-api', false)
    expect(answer.connections[0]?.reason).toBe('off')
    expect(sentFetchApiBody(SWITCH, 'PUT')).toStrictEqual({ read: false })
    expect(fetchApi.mock.calls.map((call) => [call[0], call[2]])).toStrictEqual([[PATH, 'deployment'], [SWITCH, 'deployment']])
  })
})

describe('the view', () => {
  it('reads what it does not know as nothing said, and leaves out a connection without its id', () => {
    const view = parseIssuesSource({
      deployed: 'yes', signs_in: 'oauth', app_id: 7, repositories: ['a/b', 3, ''], schedule: 'sometimes', label: '',
      connections: [entry({ reason: 'mystery', label: 'painted', read: 'maybe', reading: 'yes' }), { repository: 'x/y' },
        entry({ connection_id: 'shop', reading: false, reason: 'pending', label: null })],
    })
    expect(view).toStrictEqual({
      deployed: false, signs_in: 'none', app_id: null, repositories: [], managed: [], schedule: 'unknown', label: 'voc-agent',
      connections: [
        entry({ reason: 'unknown', label: null, read: true, reading: false }),
        entry({ connection_id: 'shop', reading: false, reason: 'pending', label: null }),
      ],
    })
  })

  it('reads an answer without its connections as an error, never as nothing read', () => {
    expect(() => parseIssuesSource({ ...VIEW, connections: undefined })).toThrow('The GitHub Issues source answer was unreadable')
    expect(() => parseIssuesSource('nothing')).toThrow('The GitHub Issues source answer was unreadable')
  })
})

describe('what followed an installation or a check', () => {
  it('is none for a missing or odd block, and keeps the readable skips and labels', () => {
    expect([parseIssuesFollow(undefined), parseIssuesFollow(null), parseIssuesFollow('yes')]).toStrictEqual([null, null, null])
    expect(parseIssuesFollow({ signs_in: 'token', added: [], reading: [], skipped: [{ repository: 'a/b', reason: 'token' }],
      labels: 'none', schedule: 'off', error: 'the secret could not be read' })).toStrictEqual({
      signs_in: 'token', added: [], reading: [], skipped: [{ repository: 'a/b', reason: 'token' }], labels: [], schedule: 'off',
      error: 'the secret could not be read',
    })
  })
})
