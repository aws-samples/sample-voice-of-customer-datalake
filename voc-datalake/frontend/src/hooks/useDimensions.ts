/**
 * @fileoverview Shared queries for the dimensions config and the source
 * profiles, so every consumer (Settings editors, filters, chips, pickers)
 * resolves to the same cache entries and normalization happens once.
 * Both are `config` keys: reused for 10 minutes (api/queryPolicies.ts).
 *
 * @module hooks/useDimensions
 */
import { useQuery } from '@tanstack/react-query'
import { dimensionsApi, dimensionsConfigKey } from '../api/dimensionsApi'
import { sourceProfilesApi, sourceProfilesKey } from '../api/sourceProfilesApi'
import { useConfigStore } from '../store/configStore'

/** The configured dimensions (empty while loading or when none are configured). */
export function useDimensionsConfig() {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  return useQuery({
    queryKey: dimensionsConfigKey(),
    queryFn: () => dimensionsApi.getConfig(),
    enabled: !!apiEndpoint,
  })
}

/** Source profiles: full rows for admins, `{id, label, restricted}` for everyone else. */
export function useSourceProfiles() {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  return useQuery({
    queryKey: sourceProfilesKey(),
    queryFn: () => sourceProfilesApi.getProfiles(),
    enabled: !!apiEndpoint,
  })
}
