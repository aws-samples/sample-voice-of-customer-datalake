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
import { agentsPath } from '../Agents/agentsPaths'
import { tokensToReplace } from '../Agents/connectionStatus'
import { adminPath } from './adminPaths'
import type { AdminTabId, AdminViewer } from './adminTabs'
import { isBlockedAccess, useModelCapacity } from './useModelCapacity'

/** One thing that needs attention: what to say, the action's label and the path where it is done. */
interface AttentionItem {
  readonly key: 'sources' | 'ways' | 'models' | 'tokens'
  readonly text: string
  readonly action: string
  readonly to: string
}

export interface AdminAttention {
  readonly items: readonly AttentionItem[]
  /** Per tab, how many things on it need attention (absent: none). */
  readonly countOf: (tab: AdminTabId) => number
}

type EnabledPlugin = ReturnType<typeof getEnabledPlugins>[number]

/** What "Needs attention" counts, from the shared reads (the sections' own query keys). */
interface AttentionFacts {
  readonly paused: readonly EnabledPlugin[]
  readonly waysUnset: number
  readonly modelsBlocked: number
  readonly tokens: number
}

/** The sources a circuit breaker paused, in the plugins' order (none until the status is read). */
function pausedSources(status: Awaited<ReturnType<typeof api.getSourcesStatus>> | undefined): EnabledPlugin[] {
  return status === undefined ? [] : getEnabledPlugins().filter((plugin) => status.sources[plugin.id]?.circuit.tripped === true)
}

/** The reads. `isAdmin` gates the admin-only ones (users, model capacity), and `agentsShown` the connections' (the
 *  Engineering agents tab's). */
function useAttentionFacts(viewer: Pick<AdminViewer, 'isAdmin' | 'agentsShown'>, ready: boolean): AttentionFacts {
  const admin = ready && viewer.isAdmin
  const agents = admin && viewer.agentsShown
  const users = useQuery({ queryKey: usersKey(), queryFn: () => api.getUsers(), enabled: admin })
  const sources = useQuery({ queryKey: sourcesStatusKey(), queryFn: () => api.getSourcesStatus(), enabled: ready })
  const capacity = useModelCapacity(admin)
  const connections = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, enabled: agents })
  return {
    paused: pausedSources(sources.data),
    waysUnset: (users.data?.users ?? []).filter((user) => user.enabled && !readStoredAiMode(user).saved).length,
    modelsBlocked: (capacity.data?.models ?? []).filter((row) => isBlockedAccess(row.access?.status ?? 'unknown')).length,
    tokens: agents ? tokensToReplace(connections.data?.connections ?? []).length : 0,
  }
}

/** The attention items, in the strip's order, and each tab's count. */
export function useAdminAttention(viewer: Pick<AdminViewer, 'isAdmin' | 'agentsShown'>, apiEndpoint: string): AdminAttention {
  const { t } = useTranslation('settings')
  const copy = usePluginCopy()
  const { paused, waysUnset, modelsBlocked, tokens } = useAttentionFacts(viewer, apiEndpoint !== '')
  const list = paused.map((plugin) => copy(plugin).name).join(', ')
  const candidates: readonly (AttentionItem & { readonly tab: AdminTabId; readonly count: number })[] = [
    { tab: 'sources', count: paused.length, key: 'sources', text: t('attention.sourcesPaused', { count: paused.length, list }),
      action: t('attention.reviewSources'), to: adminPath({ tab: 'sources', section: 'plugins' }) },
    { tab: 'access', count: waysUnset, key: 'ways', text: t('attention.waysUnset', { count: waysUnset }),
      action: t('attention.openUsers'), to: adminPath({ tab: 'access', section: 'users' }) },
    { tab: 'ai', count: modelsBlocked, key: 'models', text: t('attention.modelsBlocked', { count: modelsBlocked }),
      action: t('attention.openModels'), to: adminPath({ tab: 'ai' }) },
    { tab: 'agents', count: tokens, key: 'tokens', text: t('attention.tokensToReplace', { count: tokens }),
      // (7.66.00: where a token is replaced, Agents → Connections)
      action: t('attention.openConnections'), to: agentsPath({ view: 'connections' }) },
  ]
  const shown = candidates.filter((candidate) => candidate.count > 0)
  const counts = new Map(shown.map((candidate) => [candidate.tab, candidate.count]))
  return { items: shown.map(({ tab: _tab, count: _count, ...item }) => item), countOf: (tab) => counts.get(tab) ?? 0 }
}
