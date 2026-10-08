/**
 * @fileoverview Query key for `listSessions` (`GET /chat/conversations/_list?kind=assistant`).
 *
 * Shared by the assistant's session sidebar and Home's onboarding checklist, so
 * both read one cache entry and a save in the assistant refreshes both. Its own
 * module so test doubles of `sessionsApi` need not re-export it.
 *
 * @module assistant/sessions/queryKeys
 */
export const SESSIONS_QUERY_KEY = ['assistant', 'sessions'] as const
