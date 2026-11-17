/**
 * @fileoverview The `api/client` double and mount of the People specs (UserAdmin, the editor sheet and its sections):
 * the `api.*` user routes as spies, plus `fetchApi` for the routes the sections reach through their own API modules
 * (`/users/{username}/flags`, `/users/{username}/category-access`, the source profiles).
 *
 * `vi.mock` factories are hoisted above static imports, so a spec obtains the double through `vi.hoisted`:
 *
 *   const client = await vi.hoisted(async () => (await import('./userAdmin-sheet-fixtures')).createUserClientMock())
 *   vi.mock('../../api/client', () => client.module)
 */
import { vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { renderWithQueryClient } from '@test/query-client'
import type { CognitoUser } from '../../api/types'

type Answer = Promise<unknown>
type FetchApi = (endpoint: string, options?: RequestInit) => Answer

export function createUserClientMock() {
  const fetchApi = vi.fn<FetchApi>()
  const api = {
    getUsers: vi.fn<() => Answer>(),
    createUser: vi.fn<(data: unknown) => Answer>(),
    updateUserGroup: vi.fn<(username: string, group: string) => Answer>(),
    updateUser: vi.fn<(username: string, data: unknown) => Answer>(),
    resetUserPassword: vi.fn<(username: string) => Answer>(),
    enableUser: vi.fn<(username: string) => Answer>(),
    disableUser: vi.fn<(username: string) => Answer>(),
    deleteUser: vi.fn<(username: string) => Answer>(),
    setPlatformAdmin: vi.fn<(username: string, value: boolean) => Answer>(),
    getCategoriesConfig: vi.fn<() => Answer>(),
  }
  return {
    api,
    fetchApi,
    module: {
      api: {
        getUsers: () => api.getUsers(),
        createUser: (data: unknown) => api.createUser(data),
        updateUserGroup: (username: string, group: string) => api.updateUserGroup(username, group),
        updateUser: (username: string, data: unknown) => api.updateUser(username, data),
        resetUserPassword: (username: string) => api.resetUserPassword(username),
        enableUser: (username: string) => api.enableUser(username),
        disableUser: (username: string) => api.disableUser(username),
        deleteUser: (username: string) => api.deleteUser(username),
        setPlatformAdmin: (username: string, value: boolean) => api.setPlatformAdmin(username, value),
        getCategoriesConfig: () => api.getCategoriesConfig(),
      },
      fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options),
    },
  }
}

type UserClientMock = ReturnType<typeof createUserClientMock>

/** Per-test answers: every write succeeds, `GET /users` lists `users`, a flags or ways-of-working PUT echoes nothing. */
export function primeUserClient(client: UserClientMock, users: readonly CognitoUser[] = []): void {
  vi.clearAllMocks()
  client.api.getUsers.mockResolvedValue({ success: true, users })
  for (const write of [client.api.createUser, client.api.updateUserGroup, client.api.updateUser, client.api.resetUserPassword,
    client.api.enableUser, client.api.disableUser, client.api.deleteUser, client.api.setPlatformAdmin]) {
    write.mockResolvedValue({ success: true, message: 'ok' })
  }
  client.api.getCategoriesConfig.mockResolvedValue({ categories: [] })
  client.fetchApi.mockResolvedValue({})
}

/** A `GET /users` row with its flags and way-of-working blocks. */
export function personRow(username: string, extra: Partial<CognitoUser> & { flags?: unknown; ai_mode?: unknown } = {}): CognitoUser {
  return {
    username, email: `${username}@example.com`, name: '', given_name: '', family_name: '', status: 'CONFIRMED',
    enabled: true, groups: ['users'], created_at: null, last_modified: null, ...extra,
  }
}

/** Mount `ui` with a fresh query client; returns the user-event session. */
export function mount(ui: ReactElement) {
  const user = userEvent.setup()
  renderWithQueryClient(ui)
  return user
}
