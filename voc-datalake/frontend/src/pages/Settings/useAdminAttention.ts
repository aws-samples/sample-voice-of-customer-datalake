/**
 * @fileoverview "Needs attention" (7.54.00's home, 7.59.00 inside the tabs): what an administrator should look at,
 * from the reads the sections make anyway (same query keys), each only where its route lets this viewer:
 *
 * - the sources a breaker paused (`GET /sources/status`) → Sources → Source settings;
 * - the enabled people with no way of working saved (`GET /users`) → Privacy & access → Users;
 * - the AI models this account cannot call (`GET /settings/model/capacity`) → AI models.
 *
 * Shown twice, compactly: a count badge on each tab concerned (the tab row and the phone's select, Settings.tsx) and,
 * on General (the first tab), one strip that says what and links to it (AdminAttention.tsx).
 *
 * @module pages/Settings/useAdminAttention
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { sourcesStatusKey, usersKey } from '../../api/queryKeys'
import { readStoredAiMode } from '../../api/aiModeApi'
import { getEnabledPlugins } from '../../plugins'
import { usePluginCopy } from '../../plugins/pluginCopy'
import type { AdminTarget } from './adminPaths'
import type { AdminTabId } from './adminTabs'
import { isBlockedAccess, useModelCapacity } from './useModelCapacity'

/** One thing that needs attention: what to say, the action's label and where it is. */
interface AttentionItem {
  readonly key: 'sources' | 'ways' | 'models'
  readonly text: string
  readonly action: string
  readonly target: AdminTarget
}

export interface AdminAttention {
  readonly items: readonly AttentionItem[]
  /** Per tab, how many things on it need attention (absent: none). */
  readonly countOf: (tab: AdminTabId) => number
}

/** The attention items, from the shared reads. `isAdmin` gates the admin-only reads (users, model capacity). */
export function useAdminAttention(isAdmin: boolean, apiEndpoint: string): AdminAttention {
  const { t } = useTranslation('settings')
  const copy = usePluginCopy()
  const ready = apiEndpoint !== ''
  const users = useQuery({ queryKey: usersKey(), queryFn: () => api.getUsers(), enabled: ready && isAdmin })
  const sources = useQuery({ queryKey: sourcesStatusKey(), queryFn: () => api.getSourcesStatus(), enabled: ready })
  const capacity = useModelCapacity(ready && isAdmin)
  const paused = sources.data === undefined
    ? []
    : getEnabledPlugins().filter((plugin) => sources.data.sources[plugin.id]?.circuit.tripped === true)
  const waysUnset = (users.data?.users ?? []).filter((user) => user.enabled && !readStoredAiMode(user).saved).length
  const modelsBlocked = (capacity.data?.models ?? []).filter((row) => isBlockedAccess(row.access?.status ?? 'unknown')).length
  const counts: Partial<Record<AdminTabId, number>> = {}
  const items: AttentionItem[] = []
  if (paused.length > 0) {
    counts.sources = paused.length
    const list = paused.map((plugin) => copy(plugin).name).join(', ')
    items.push({ key: 'sources', text: t('attention.sourcesPaused', { count: paused.length, list }),
      action: t('attention.reviewSources'), target: { tab: 'sources', section: 'plugins' } })
  }
  if (waysUnset > 0) {
    counts.access = waysUnset
    items.push({ key: 'ways', text: t('attention.waysUnset', { count: waysUnset }), action: t('attention.openUsers'),
      target: { tab: 'access', section: 'users' } })
  }
  if (modelsBlocked > 0) {
    counts.ai = modelsBlocked
    items.push({ key: 'models', text: t('attention.modelsBlocked', { count: modelsBlocked }), action: t('attention.openModels'),
      target: { tab: 'ai' } })
  }
  return { items, countOf: (tab) => counts[tab] ?? 0 }
}

