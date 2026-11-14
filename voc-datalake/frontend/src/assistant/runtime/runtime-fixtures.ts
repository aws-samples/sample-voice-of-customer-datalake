/**
 * @fileoverview Test fixtures for the assistant runtime specs: the mocked `sessions/sessionsApi` module
 * (wire it with `vi.mock('../sessions/sessionsApi', () => import('./runtime-fixtures').then((m) => m.sessionsApiModule()))`),
 * the home-page run environment and a session record the server is still generating.
 */
import { vi } from 'vitest'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import type { SessionRecord } from '../sessions/schema'
import type { RunEnvironment } from './runtime'

/** A `sessions/sessionsApi` module of spies: saves and cancels resolve, `getSession` is programmed per test. */
export function sessionsApiModule() {
  return {
    // Unprogrammed, the server holds no session: `null`, which the real API answers and adoptAfterStop and
    // followServerRun read as "nothing newer" (never `undefined`, which the API never returns).
    getSession: vi.fn(() => Promise.resolve(null)),
    saveSession: vi.fn(() => Promise.resolve()),
    cancelServerRun: vi.fn(() => Promise.resolve()),
    // The real reading: a 404 from a chat route is "this workspace keeps no conversations for the caller".
    isNotSavedHere: (error: unknown) => apiErrorStatus(error) === 404,
  }
}

/** A run started on Home, without web search. */
export const HOME_ENV: RunEnvironment = { page: { kind: 'home', path: '/' }, useWebSearch: false }

/** Session `conv_1` as the server stores it while its run is still going (revision 10), with `overrides`. */
export function runningSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'conv_1',
    messages: [{ id: 'u1', role: 'user', content: 'Why?' }, { id: 'a1', role: 'assistant', content: 'Because' }],
    pendingInterrupts: [], createdAt: '2026-10-06T11:59:00.000Z',
    updatedAt: new Date(Date.now()).toISOString(), runStatus: 'running', revision: 10,
    ...overrides,
  }
}
