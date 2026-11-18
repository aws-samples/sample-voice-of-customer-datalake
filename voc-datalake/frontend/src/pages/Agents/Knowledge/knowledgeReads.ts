/**
 * @fileoverview The knowledge flows' reads (KnowledgeReview, TenetsReview): each waits for the deployment's API and,
 * for a version, for one to be chosen.
 *
 * @module pages/Agents/Knowledge/knowledgeReads
 */
import { useQuery } from '@tanstack/react-query'
import { useConfigStore } from '../../../store/configStore'
import type { QueryKey } from '@tanstack/react-query'

/** `read` under `key`, once the API is configured and `ready` (a version chosen, for a version's read). */
export function useKnowledgeRead<T>(key: QueryKey, read: () => Promise<T>, ready = true) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({ queryKey: key, queryFn: read, enabled: configured && ready })
}
