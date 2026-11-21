/**
 * @fileoverview The fine-grained token connections' clients (7.60.00): a new token connection and a replaced token
 * (each with `only_this_repository: true`, the reason only when given), a run's go, the connections' new credential
 * fields.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { FAKE_TOKEN, tokenConnection } from '@test/tokenConnectionFixtures'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { tokenConnectionsApi } = await import('./tokenConnectionsApi')
const { engineeringGoApi } = await import('./engineeringGoApi')
const { engineeringConnectionsApi, isTokenConnection } = await import('./engineeringConnectionsApi')

const CONNECTION = tokenConnection('partner-sdk', 'partner-org/sdk', 10)
const RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'

beforeEach(() => { resetFetchApi() })

describe('a token connection', () => {
  it('is saved with the tick sent, and the reason only when given', async () => {
    routeFetchApi({ 'POST /agents/engineering/token-connections': () => ({ connection: CONNECTION, created: true }) })
    const saved = await tokenConnectionsApi.create({ repository: 'partner-org/sdk', token: FAKE_TOKEN, reason: '  ' })
    expect(sentFetchApiBody('/agents/engineering/token-connections', 'POST'))
      .toStrictEqual({ repository: 'partner-org/sdk', token: FAKE_TOKEN, only_this_repository: true })
    expect([saved.created, saved.connection.kind, isTokenConnection(saved.connection)]).toStrictEqual([true, 'fine_grained', true])
  })

  it('has its token replaced on its own path, with the reason trimmed', async () => {
    routeFetchApi({ 'PUT /agents/engineering/connections/partner-sdk/token': () => ({ connection: CONNECTION }) })
    const connection = await tokenConnectionsApi.replace('partner-sdk', { token: FAKE_TOKEN, reason: ' renewal ' })
    expect(sentFetchApiBody('/agents/engineering/connections/partner-sdk/token', 'PUT'))
      .toStrictEqual({ token: FAKE_TOKEN, only_this_repository: true, reason: 'renewal' })
    expect(connection.credential).toMatchObject({ kind: 'fine_grained_token', login: 'casey-dev', expires_in_days: 10, saved_by_you: true })
  })

  it('reads an answer without a connection as an error', async () => {
    routeFetchApi({ 'POST /agents/engineering/token-connections': () => ({ created: true }) })
    await expect(tokenConnectionsApi.create({ repository: 'a/b', token: FAKE_TOKEN })).rejects.toThrow('The saved connection was unreadable')
  })
})

describe('the connections\' credential fields', () => {
  it('read a connection stored before 7.60.00 with no login, no days left and not saved by the viewer', async () => {
    routeFetchApi({ 'GET /agents/engineering/connections': () => ({ connections: [{
      connection_id: 'web', host: 'github', repository: 'example-org/web', credential: { kind: 'app', set: true },
    }], limit: 20 }) })
    const [web] = (await engineeringConnectionsApi.list()).connections
    expect(web?.credential).toMatchObject({ expires_in_days: null, login: null, saved_by_you: false, owner: null })
  })
})

describe('a run\'s go', () => {
  it('is posted empty and read as given now or already', async () => {
    routeFetchApi({ [`POST /agents/engineering/${RUN}/go`]: () => ({ go: { by: 'person:sub', at: '2026-11-20T10:00:00Z', created: false } }) })
    expect(await engineeringGoApi.give(RUN)).toStrictEqual({ created: false })
    expect(sentFetchApiBody(`/agents/engineering/${RUN}/go`, 'POST')).toStrictEqual({})
  })

  it('reads an answer without its go as an error', async () => {
    routeFetchApi({ [`POST /agents/engineering/${RUN}/go`]: () => ({ go: { created: true } }) })
    await expect(engineeringGoApi.give(RUN)).rejects.toThrow('The go was unreadable')
  })
})
