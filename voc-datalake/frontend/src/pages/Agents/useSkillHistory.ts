/**
 * @fileoverview A role's history in a scope, a page at a time (`GET /agents/engineering/skills/<role>/versions`), as
 * Agents → Skills reads it: one cache entry the history list and the role's "Template updated" panel share (since
 * 7.50.00 the first page also names the role's template, `template: {version, label, newer}`).
 *
 * @module pages/Agents/useSkillHistory
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { useConfigStore } from '../../store/configStore'
import type { SkillRole } from '../../api/engineeringSkillsApi'

export function useSkillHistory(connection: string, role: SkillRole) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useInfiniteQuery({
    queryKey: engineeringSkillsKeys.history(connection, role),
    queryFn: ({ pageParam }) => engineeringSkillsApi.history(connection, role, pageParam),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextPage ?? undefined,
    enabled: configured,
  })
}
