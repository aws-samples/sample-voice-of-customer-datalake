/**
 * @fileoverview Admin endpoint groups of the API client: Cognito user
 * administration and the system logs. Spread into `api` by `./client`; see
 * `./requestKit` for why these are factories.
 */
import { buildSearchParams, type FetchApi } from './requestKit'
import type {
  CognitoUser, LogsSummary, ProcessingLogEntry, ScraperLogEntry, ValidationLogEntry,
} from './types'

type UserMessage = { success: boolean; message: string }

/** `/users/*` — admin only, enforced by the route. */
export function userAdminEndpoints(fetchApi: FetchApi) {
  const userPath = (username: string, suffix = '') => `/users/${encodeURIComponent(username)}${suffix}`
  return {
    getUsers: () => fetchApi<{ success: boolean; users: CognitoUser[]; message?: string }>('/users'),

    createUser: (data: {
      username: string
      email: string
      name?: string
      given_name?: string
      family_name?: string
      group: 'admins' | 'users'
    }) =>
      fetchApi<{ success: boolean; message?: string; error?: string; user?: CognitoUser }>('/users', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    updateUserGroup: (username: string, group: 'admins' | 'users') =>
      fetchApi<UserMessage>(userPath(username, '/group'), { method: 'PUT', body: JSON.stringify({ group }) }),

    // Update user attributes (first/last name). Used by EditUserModal.
    updateUser: (username: string, data: { given_name: string; family_name: string }) =>
      fetchApi<UserMessage & { given_name: string; family_name: string; name: string }>(userPath(username), {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    resetUserPassword: (username: string) =>
      fetchApi<UserMessage>(userPath(username, '/reset-password'), { method: 'POST' }),

    enableUser: (username: string) => fetchApi<UserMessage>(userPath(username, '/enable'), { method: 'PUT' }),

    disableUser: (username: string) => fetchApi<UserMessage>(userPath(username, '/disable'), { method: 'PUT' }),

    deleteUser: (username: string) => fetchApi<UserMessage>(userPath(username), { method: 'DELETE' }),
  }
}

/** `/logs/*` — validation failures, processing errors, scraper runs. The reads are
 *  open to every authenticated user; `DELETE /logs/validation/{source}` (the only
 *  delete route in `logs_handler.py`) is admin-only, enforced by the route. */
export function logsEndpoints(fetchApi: FetchApi) {
  return {
    getValidationLogs: (params?: { source?: string; days?: number; limit?: number }) =>
      fetchApi<{ logs: ValidationLogEntry[]; count: number; days: number }>(
        `/logs/validation?${buildSearchParams(params ?? {})}`,
      ),

    getProcessingLogs: (params?: { source?: string; days?: number; limit?: number }) =>
      fetchApi<{ logs: ProcessingLogEntry[]; count: number; days: number }>(
        `/logs/processing?${buildSearchParams(params ?? {})}`,
      ),

    getScraperLogs: (scraperId: string, params?: { days?: number; limit?: number }) =>
      fetchApi<{ scraper_id: string; logs: ScraperLogEntry[]; count: number }>(
        `/logs/scraper/${scraperId}?${buildSearchParams(params ?? {})}`,
      ),

    getLogsSummary: (days?: number) =>
      fetchApi<{ summary: LogsSummary; days: number }>(`/logs/summary?${buildSearchParams({ days })}`),

    // Admin-only server-side (403 for anyone else), so its UI control must be gated on `useIsAdmin`.
    clearValidationLogs: (source: string) =>
      fetchApi<{ success: boolean; deleted: number }>(`/logs/validation/${source}`, { method: 'DELETE' }),
  }
}
