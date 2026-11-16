/**
 * @fileoverview The readiness read an engineering automation's controls share (api/engineeringReadinessApi.ts): one
 * cache entry per automation, kept 15 s, never retried (a failure shows at once; Enable stays the server's to refuse).
 *
 * @module pages/Agents/useReadiness
 */
import { useQuery } from '@tanstack/react-query'
import { engineeringReadinessApi, engineeringReadinessKeys } from '../../api/engineeringReadinessApi'
import type { ReadinessSubject } from '../../api/engineeringReadinessApi'

/** The readiness of `subject`, read while `enabled` (an administrator, with the engineering agents on). */
export function useReadiness(subject: ReadinessSubject, enabled: boolean) {
  return useQuery({
    queryKey: engineeringReadinessKeys.of(subject),
    queryFn: () => engineeringReadinessApi.checks(subject),
    enabled,
    retry: false,
    staleTime: 15_000,
  })
}
