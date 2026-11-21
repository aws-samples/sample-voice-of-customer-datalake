/**
 * @fileoverview What the chosen role playbook's browser evidence reads (7.66.00): the caller's brief settings and
 * projects (under the SAME query keys Home's brief, the Projects page and the setup checklist use, so they share the
 * cache), the engineering connections (an administrator's list, only while the engineering agents are on)
 * and the caller's MCP tokens (Connect's list). Each is read only when the playbook has a step it ticks, so a playbook
 * costs nothing it does not show. A failed read counts as "not done yet": the step's link still leads where to do it.
 *
 * @module pages/Home/playbooks/usePlaybookFacts
 */
import { useQuery } from '@tanstack/react-query'
import { briefPreferencesKey, briefingApi } from '../../../api/briefingApi'
import { connectApi, CONNECT_TOKENS_KEY } from '../../../api/connectApi'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../../api/engineeringConnectionsApi'
import { projectsApi } from '../../../api/projectsApi'
import { projectsKey } from '../../../api/projectQueryKeys'
import { isMenuItemEnabled } from '../../../config/menuConfig'
import { isEngineeringAvailable } from '../../../runtimeConfig'
import { useAuthStore, useIsAdmin } from '../../../store/authStore'
import { useConfigStore } from '../../../store/configStore'
import { needsEvidence } from './playbookCatalogue'
import type { PlaybookRole } from '../../../api/onboardingApi'
import type { BrowserFacts } from './playbookSteps'

/** How many rows the query holds: 0 once it failed, undefined while it is loading (or not asked). */
function countOf<T>(query: { data: T | undefined; isError: boolean }, rows: (data: T) => readonly unknown[]): number | undefined {
  if (query.isError) return 0
  return query.data === undefined ? undefined : rows(query.data).length
}

const PROJECT_EVIDENCE = ['personas_generated', 'document_written', 'project_shared'] as const

/** Whether the caller's morning brief is on (false once the read failed, undefined while loading or not asked). */
function useBriefSubscribed(role: PlaybookRole | null, enabled: boolean, userSub: string | undefined): boolean | undefined {
  // (Home's brief reads the same settings under the same key: useBriefPreferences)
  const brief = useQuery({ queryKey: [...briefPreferencesKey(), userSub ?? ''] as const, queryFn: briefingApi.getPreferences,
    enabled: enabled && needsEvidence(role, 'brief_subscribed') })
  return brief.isError ? false : brief.data?.enabled
}

export function usePlaybookFacts(role: PlaybookRole | null): BrowserFacts {
  const userSub = useAuthStore().user?.sub
  const isAdmin = useIsAdmin()
  const enabled = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const briefSubscribed = useBriefSubscribed(role, enabled, userSub)
  const projects = useQuery({ queryKey: projectsKey(), queryFn: projectsApi.getProjects,
    enabled: enabled && PROJECT_EVIDENCE.some((name) => needsEvidence(role, name)) })
  // The connections list is an administrator's, on while the engineering agents are (useAdminLocation's rule).
  const connectionsShown = isAdmin && isMenuItemEnabled('agents') && isEngineeringAvailable()
  const connections = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list,
    enabled: enabled && connectionsShown && needsEvidence(role, 'repository_connected') })
  const tokens = useQuery({ queryKey: CONNECT_TOKENS_KEY, queryFn: connectApi.listTokens,
    enabled: enabled && needsEvidence(role, 'mcp_connected') })
  return {
    userSub,
    briefSubscribed,
    projects: projects.isError ? [] : projects.data?.projects,
    // Not shown to this person: never "done" by itself, the step stays theirs to tick.
    connectionCount: connectionsShown ? countOf(connections, (list) => list.connections) : 0,
    tokenCount: countOf(tokens, (list) => list.tokens),
  }
}
