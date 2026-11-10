/**
 * @fileoverview Admin endpoint groups of the API client: Cognito user
 * administration and the system logs. Spread into `api` by `./client`; see
 * `./requestKit` for why these are factories.
 */
import { buildSearchParams, del, post, put, type FetchApi } from './requestKit'
import type {
  CognitoUser, LogsSummary, ProcessingLogEntry, ScraperLogEntry, ValidationLogEntry,
} from './types'
import { normalizeSystemLogs, type SystemLogs, type SystemLogsParams } from './systemLogs'
import {
  normalizeSystemEnvironment, normalizeSystemFailureQueues, normalizeSystemRequest,
  type SystemEnvironmentEntry, type SystemFailureQueues, type SystemRequest, type SystemRequestParams,
} from './systemDiagnostics'

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
      fetchApi<{ success: boolean; message?: string; error?: string; user?: CognitoUser }>('/users', post(data)),

    updateUserGroup: (username: string, group: 'admins' | 'users') =>
      fetchApi<UserMessage>(userPath(username, '/group'), put({ group })),

    // Update user attributes (first/last name). Used by EditUserModal.
    updateUser: (username: string, data: { given_name: string; family_name: string }) =>
      fetchApi<UserMessage & { given_name: string; family_name: string; name: string }>(userPath(username), put(data)),

    resetUserPassword: (username: string) =>
      fetchApi<UserMessage>(userPath(username, '/reset-password'), post()),

    enableUser: (username: string) => fetchApi<UserMessage>(userPath(username, '/enable'), put()),

    disableUser: (username: string) => fetchApi<UserMessage>(userPath(username, '/disable'), put()),

    deleteUser: (username: string) => fetchApi<UserMessage>(userPath(username), del()),
  }
}

/** `/logs/*` — validation failures, processing errors, scraper runs, system errors.
 *  The reads are open to every authenticated user except `GET /logs/system`;
 *  it and `DELETE /logs/validation/{source}` (the only delete route in
 *  `logs_handler.py`) are admin-only, enforced by the route. */
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

    // Admin-only server-side (403 for anyone else): the panel queries only for admins.
    getSystemLogs: async (params: SystemLogsParams): Promise<SystemLogs> =>
      normalizeSystemLogs(await fetchApi<unknown>(`/logs/system?${buildSearchParams(params)}`)),

    // The three diagnostics beside it are admin-only too (shared/system_*.py).
    getSystemRequest: async (params: SystemRequestParams): Promise<SystemRequest> =>
      normalizeSystemRequest(await fetchApi<unknown>(`/logs/system/request?${buildSearchParams(params)}`)),

    getSystemFailureQueues: async (): Promise<SystemFailureQueues> =>
      normalizeSystemFailureQueues(await fetchApi<unknown>('/logs/system/queues')),

    getSystemEnvironment: async (): Promise<SystemEnvironmentEntry[]> =>
      normalizeSystemEnvironment(await fetchApi<unknown>('/logs/system/environment')),

    // Admin-only server-side (403 for anyone else), so its UI control must be gated on `useIsAdmin`.
    clearValidationLogs: (source: string) =>
      fetchApi<{ success: boolean; deleted: number }>(`/logs/validation/${source}`, del()),
  }
}
