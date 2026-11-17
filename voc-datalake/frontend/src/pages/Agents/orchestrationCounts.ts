/**
 * @fileoverview The counts on Agent orchestration's tabs and its Needs you strip (7.52.00 C1; ux-agents-redesign part 4
 * §4.3, §4.4): what waits for a person.
 *
 * - **Runs:** the engineering runs of this month waiting for a person (`GET /agents/engineering/runs?status=needs_human`,
 *   its first page: the count the Runs tab's filter shows), and the automations whose last run needs a decision (the
 *   agents list the sidebar's count reads).
 * - **Skills:** the shared skills' roles whose newest version is proposed and waits for review
 *   (`GET /agents/engineering/skills`, the Skills tab's own read of the shared scope).
 *
 * An administrator's, while the engineering agents are on; a count not known (its read failed, or not made) is null,
 * and the tab shows none (never a made-up zero).
 *
 * @module pages/Agents/orchestrationCounts
 */
import { useQuery } from '@tanstack/react-query'
import { currentMonth } from '../../api/engineeringSpendApi'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { runWorkspaceApi, runWorkspaceKeys } from '../../api/engineeringRunWorkspaceApi'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { useConfigStore } from '../../store/configStore'
import type { SkillRoleLine } from '../../api/engineeringSkillsApi'

/** The shared scope (the Skills tab's first scope). */
const SHARED_SCOPE = ''

/** A role whose newest version is proposed: waiting for an administrator's review. */
const waitsForReview = (role: Pick<SkillRoleLine, 'latest'>): boolean => role.latest?.status === 'proposed'

/** Whether the counts are read here: an administrator's page, with the engineering agents on. */
function useCountsRead(isAdmin: boolean): boolean {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return configured && isAdmin && isEngineeringAvailable()
}

/** This month's engineering runs waiting for a person (the first page's), or null when not known. */
export function useRunsNeedingYou(isAdmin: boolean): number | null {
  const enabled = useCountsRead(isAdmin)
  const query = { month: currentMonth(), flow: '', status: 'needs_human' }
  const read = useQuery({
    // (under the runs lists' key, so what refreshes a list refreshes the count)
    queryKey: [...runWorkspaceKeys.runsLists(), query.month, query.status, 'count'],
    queryFn: () => runWorkspaceApi.runs(query, null),
    enabled,
    retry: false,
    staleTime: 30_000,
  })
  return enabled && read.data !== undefined ? read.data.rows.length : null
}

/** The shared skills' roles waiting for review, or null when not known. */
export function useSkillsToReview(isAdmin: boolean): readonly SkillRoleLine[] | null {
  const enabled = useCountsRead(isAdmin)
  const read = useQuery({
    queryKey: engineeringSkillsKeys.roles(SHARED_SCOPE),
    queryFn: () => engineeringSkillsApi.roles(SHARED_SCOPE),
    enabled,
    retry: false,
  })
  return enabled && read.data !== undefined ? read.data.filter(waitsForReview) : null
}
