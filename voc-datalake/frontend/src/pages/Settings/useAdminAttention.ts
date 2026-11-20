/**
 * @fileoverview "Needs attention" (7.54.00's home, 7.59.00 inside the tabs): what an administrator should look at,
 * from the reads the sections make anyway (same query keys), each only where its route lets this viewer:
 *
 * - the sources a breaker paused (`GET /sources/status`) → Sources → Source settings;
 * - the enabled people with no way of working saved (`GET /users`) → Privacy & access → Users;
 * - the AI models this account cannot call (`GET /settings/model/capacity`) → AI models;
 * - (7.60.00) the fine-grained tokens to replace, expiring within 14 days, expired, not set or of an unknown expiry
 *   (`GET /agents/engineering/connections`, while the Engineering agents tab is shown) → Engineering agents → GitHub
 *   connections, which lists them.
 *
 * Shown twice, compactly: a count badge on each tab concerned (the tab row and the phone's select, Settings.tsx) and,
 * on General (the first tab), one strip that says what and links to it (AdminAttention.tsx).
 *
 * @module pages/Settings/useAdminAttention
 */
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { sourcesStatusKey, usersKey } from '../../api/queryKeys'
import { readStoredAiMode } from '../../api/aiModeApi'
import { getEnabledPlugins } from '../../plugins'
import { usePluginCopy } from '../../plugins/pluginCopy'
import { tokensToReplace } from '../Agents/connectionStatus'
import type { AdminTarget } from './adminPaths'
import type { AdminTabId, AdminViewer } from './adminTabs'
import { isBlockedAccess, useModelCapacity } from './useModelCapacity'

/** One thing that needs attention: what to say, the action's label and where it is. */
interface AttentionItem {
  readonly key: 'sources' | 'ways' | 'models' | 'tokens'
  readonly text: string
  readonly action: string
  readonly target: AdminTarget
}

export interface AdminAttention {
  readonly items: readonly AttentionItem[]
  /** Per tab, how many things on it need attention (absent: none). */
  readonly countOf: (tab: AdminTabId) => number
}

/** The attention items, from the shared reads. `isAdmin` gates the admin-only reads (users, model capacity), and
 *  `agentsShown` the connections' (the Engineering agents tab's). */
export function useAdminAttention(viewer: Pick<AdminViewer, 'isAdmin' | 'agentsShown'>, apiEndpoint: string): AdminAttention {
  const { t } = useTranslation('settings')
  const copy = usePluginCopy()
  const ready = apiEndpoint !== ''
  const { isAdmin } = viewer
  const users = useQuery({ queryKey: usersKey(), queryFn: () => api.getUsers(), enabled: ready && isAdmin })
  const sources = useQuery({ queryKey: sourcesStatusKey(), queryFn: () => api.getSourcesStatus(), enabled: ready })
  const capacity = useModelCapacity(ready && isAdmin)
  const connections = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list,
    enabled: ready && isAdmin && viewer.agentsShown })
  const paused = sources.data === undefined
    ? []
    : getEnabledPlugins().filter((plugin) => sources.data.sources[plugin.id]?.circuit.tripped === true)
  const waysUnset = (users.data?.users ?? []).filter((user) => user.enabled && !readStoredAiMode(user).saved).length
  const modelsBlocked = (capacity.data?.models ?? []).filter((row) => isBlockedAccess(row.access?.status ?? 'unknown')).length
  const tokens = viewer.agentsShown ? tokensToReplace(connections.data?.connections ?? []).length : 0
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
  if (tokens > 0) {
    counts.agents = tokens
    items.push({ key: 'tokens', text: t('attention.tokensToReplace', { count: tokens }), action: t('attention.openConnections'),
      target: { tab: 'agents', card: 'connections' } })
  }
  return { items, countOf: (tab) => counts[tab] ?? 0 }
}

