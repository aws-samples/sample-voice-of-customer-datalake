/**
 * An approved user-administration write goes out through the real API client
 * with the signed-in user's own Cognito token — no other credential, no other
 * path — and in the order the card promised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

const API = 'https://api.example.com'
vi.mock('../../store/configStore', () => import('@test/api-mocks').then((m) => m.configStoreMock('https://api.example.com')))
vi.mock('../../runtimeConfig', () => import('@test/api-mocks').then((m) => m.runtimeConfigMock('https://api.example.com')))
vi.mock('../../services/auth', () => import('@test/api-mocks').then((m) => m.authServiceMock()))

import { getWriteTool } from './registry'
import { createShownRecord, recordAccessBase, recordUserBase } from './shown'
import { accessFingerprint, userFingerprint } from './userSchemas'
import { normalizeUserGrant } from '../../api/categoryAccessApi'
import { MOCK_ID_TOKEN } from '@test/api-mocks'
import { fetchMock, installFetchMock, mockJsonOnce, requestHeaders, requestUrl } from '@test/fetch-mock'
import type { ShownRecord } from './shown'
import type { WriteToolExecutionContext } from '../types'

const ALICE = { username: 'u-alice', email: 'alice@example.com', given_name: 'Alice', family_name: 'Doe', groups: ['users'], enabled: true }
const GRANT = { username: 'u-alice', all: true, categories: ['*'], sources: null }

beforeEach(() => {
  installFetchMock()
})

const context = (shown: ShownRecord = createShownRecord()): WriteToolExecutionContext =>
  ({ queryClient: new QueryClient(), shown })

/** `[url, method, Authorization]` of every request the executor made, in order. */
function requests(): Array<[string, unknown, string | undefined]> {
  return fetchMock().mock.calls.map((call: unknown[], index) => {
    const init: unknown = call[1]
    const method = typeof init === 'object' && init !== null && 'method' in init ? init.method : 'GET'
    return [requestUrl(index), method, requestHeaders(index)['Authorization']]
  })
}

describe('the user tools execute with the user token', () => {
  it('create_user reads the list, then POSTs /users with the user\u2019s Authorization header', async () => {
    mockJsonOnce({ success: true, users: [ALICE] })
    mockJsonOnce({ success: true, user: { ...ALICE, username: 'u-new' } })
    await getWriteTool('create_user')?.execute({ email: 'bob@example.com', role: 'users' }, context())
    expect(requests()).toStrictEqual([
      [`${API}/users`, 'GET', MOCK_ID_TOKEN],
      [`${API}/users`, 'POST', MOCK_ID_TOKEN],
    ])
  })

  it('update_user reads the list, then PUTs the name, the group and the enabled state, in that order', async () => {
    mockJsonOnce({ success: true, users: [ALICE] })
    // Every write after the read answers ok.
    fetchMock().mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, message: 'ok', given_name: 'Alicia', family_name: 'Doe', name: 'Alicia Doe' }) })
    const shown = createShownRecord()
    recordUserBase(shown, userFingerprint(ALICE))
    await getWriteTool('update_user')?.execute({ username: 'u-alice', updates: { given_name: 'Alicia', role: 'admins', enabled: false } }, context(shown))
    expect(requests()).toStrictEqual([
      [`${API}/users`, 'GET', MOCK_ID_TOKEN],
      [`${API}/users/u-alice`, 'PUT', MOCK_ID_TOKEN],
      [`${API}/users/u-alice/group`, 'PUT', MOCK_ID_TOKEN],
      [`${API}/users/u-alice/disable`, 'PUT', MOCK_ID_TOKEN],
    ])
  })

  it('set_user_access reads the grant, then PUTs it, both as the user', async () => {
    mockJsonOnce(GRANT)
    mockJsonOnce({ ...GRANT, all: false, categories: ['delivery'] })
    const shown = createShownRecord()
    recordAccessBase(shown, accessFingerprint(normalizeUserGrant(GRANT)))
    await getWriteTool('set_user_access')?.execute({ username: 'u-alice', categories: ['delivery'] }, context(shown))
    expect(requests()).toStrictEqual([
      [`${API}/users/u-alice/category-access`, 'GET', MOCK_ID_TOKEN],
      [`${API}/users/u-alice/category-access`, 'PUT', MOCK_ID_TOKEN],
    ])
  })
})
