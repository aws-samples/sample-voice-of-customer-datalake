/**
 * @fileoverview Query keys that more than one feature reads or invalidates.
 *
 * The rule of `projectQueryKeys.ts`, applied to the rest of the app: a key stays
 * private to its page until a second feature reads it, and moves here when one
 * does. A key spelled as a literal in two places keeps working right up until one
 * copy is renamed; then an invalidation silently stops reaching its query.
 * `scripts/audit/ts_query_keys.mjs` reports a key spelled inline in two files.
 *
 * Like `projectQueryKeys.ts`, this file imports nothing, so the always-loaded
 * chunks can name a key without pulling a page's data layer in.
 *
 * @module api/queryKeys
 */

/** Cognito users (Settings → Users, the category-owner picker). */
export const usersKey = () => ['users'] as const

/** The caller's own way of working with AI (`GET /users/me/ai-mode`; the PR/FAQ / PRD editor). */
export const myAiModeKey = () => ['my-ai-mode'] as const

/** The scraper configs (Data sources, Settings → Logs, the sources manager, onboarding). */
export const scrapersKey = () => ['scrapers'] as const

/** Per-surface model overrides + allowlist (Settings → AI models, the agent Models tab). */
export const modelSettingsKey = () => ['model-settings'] as const

/** Model quotas + the image model's access (Settings → AI models; GET /settings/model/capacity). */
export const modelCapacityKey = () => ['model-capacity'] as const

/** Problems marked resolved (Problem analysis, the assistant's resolve tool). */
export const resolvedProblemsKey = () => ['resolved-problems'] as const

/** One plugin's app connectors. */
export const appConfigsKey = (pluginId: string) => ['app-configs', pluginId] as const

/** Every plugin's app connectors: the root alone matches every list, `ids` names one read. */
export const allAppConfigsKey = (...ids: readonly string[]) => ['all-app-configs', ...ids] as const

/** A plugin's latest manual run: the root alone matches every plugin's. */
/** `GET /sources/status` (every plugin's schedule on/off and circuit): one call per page, shared by its readers. */
export const sourcesStatusKey = () => ['sources-status'] as const

export const sourceRunStatusKey = (...pluginIds: readonly string[]) => ['source-run-status', ...pluginIds] as const

/**
 * The metrics and feedback reads several pages share. Each takes the read's own
 * parameters after the root (a date window, a source, …); the root alone is the
 * prefix that invalidates every read of that family.
 */
export const metricsKeys = {
  feedback: (...params: readonly unknown[]) => ['feedback', ...params] as const,
  sources: (...params: readonly unknown[]) => ['sources', ...params] as const,
  sentiment: (...params: readonly unknown[]) => ['sentiment', ...params] as const,
  categories: (...params: readonly unknown[]) => ['categories', ...params] as const,
}
