/**
 * @fileoverview Logs, API token, and user admin endpoints,
 * extracted from client.ts to stay under the max-lines limit.
 * Re-exported via the main `api` object in client.ts.
 */
import {
  fetchApi, buildSearchParams,
} from './client'
import type {
  ApiToken,
  CognitoUser,
  CreateApiTokenResponse,
  LogsSummary,
  ProcessingLogEntry,
  ScraperLogEntry,
  ValidationLogEntry,
} from './types'

export const logsApi = {
  // ── User Administration (admin only) ────────────────────────────────────
  getUsers: () => fetchApi<{
    success: boolean;
    users: CognitoUser[];
    message?: string
  }>('/users'),

  createUser: (data: {
    username: string;
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    group: 'admins' | 'users'
  }) =>
    fetchApi<{
      success: boolean;
      message?: string;
      error?: string;
      user?: CognitoUser
    }>('/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateUserGroup: (username: string, group: 'admins' | 'users') =>
    fetchApi<{
      success: boolean;
      message: string
    }>(`/users/${encodeURIComponent(username)}/group`, {
      method: 'PUT',
      body: JSON.stringify({ group }),
    }),

  updateUser: (username: string, data: {
    given_name: string;
    family_name: string
  }) =>
    fetchApi<{
      success: boolean;
      message: string;
      given_name: string;
      family_name: string;
      name: string
    }>(`/users/${encodeURIComponent(username)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  resetUserPassword: (username: string) =>
    fetchApi<{
      success: boolean;
      message: string
    }>(`/users/${encodeURIComponent(username)}/reset-password`, { method: 'POST' }),

  enableUser: (username: string) =>
    fetchApi<{
      success: boolean;
      message: string
    }>(`/users/${encodeURIComponent(username)}/enable`, { method: 'PUT' }),

  disableUser: (username: string) =>
    fetchApi<{
      success: boolean;
      message: string
    }>(`/users/${encodeURIComponent(username)}/disable`, { method: 'PUT' }),

  deleteUser: (username: string) =>
    fetchApi<{
      success: boolean;
      message: string
    }>(`/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),

  // ── Logs ────────────────────────────────────────────────────────────────
  getValidationLogs: (params?: {
    source?: string;
    days?: number;
    limit?: number
  }) => {
    const searchParams = buildSearchParams(params ?? {})
    return fetchApi<{
      logs: ValidationLogEntry[];
      count: number;
      days: number
    }>(`/logs/validation?${searchParams}`)
  },

  getProcessingLogs: (params?: {
    source?: string;
    days?: number;
    limit?: number
  }) => {
    const searchParams = buildSearchParams(params ?? {})
    return fetchApi<{
      logs: ProcessingLogEntry[];
      count: number;
      days: number
    }>(`/logs/processing?${searchParams}`)
  },

  getScraperLogs: (scraperId: string, params?: {
    days?: number;
    limit?: number
  }) => {
    const searchParams = buildSearchParams(params ?? {})
    return fetchApi<{
      scraper_id: string;
      logs: ScraperLogEntry[];
      count: number
    }>(`/logs/scraper/${scraperId}?${searchParams}`)
  },

  getLogsSummary: (days?: number) => {
    const searchParams = buildSearchParams({ days })
    return fetchApi<{
      summary: LogsSummary;
      days: number
    }>(`/logs/summary?${searchParams}`)
  },

  clearValidationLogs: (source: string) =>
    fetchApi<{
      success: boolean;
      deleted: number
    }>(`/logs/validation/${source}`, { method: 'DELETE' }),

  createApiToken: (projectId: string, data: {
    name: string;
    scope: 'read' | 'read-write'
  }) =>
    fetchApi<CreateApiTokenResponse>(`/projects/${projectId}/api-tokens`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  listApiTokens: (projectId: string) =>
    fetchApi<{
      success: boolean;
      tokens: ApiToken[]
    }>(`/projects/${projectId}/api-tokens`),

  deleteApiToken: (projectId: string, tokenId: string) =>
    fetchApi<{
      success: boolean;
      message: string
    }>(`/projects/${projectId}/api-tokens/${tokenId}`, { method: 'DELETE' }),
}
