/**
 * @fileoverview Shared queries for the dimensions config and the source
 * profiles, so every consumer (Settings editors, filters, chips, pickers)
 * resolves to the same cache entries and normalization happens once.
 * Both are `config` keys: reused for 10 minutes (api/queryPolicies.ts).
 *
 * @module hooks/useDimensions
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { dimensionsApi, dimensionsConfigKey } from '../api/dimensionsApi'
import { localizeBuiltinDimensions } from '../api/builtinDimensionLabels'
import type { DimensionsConfig } from '../api/dimensionsSchema'
import { sourceProfilesApi, sourceProfilesKey } from '../api/sourceProfilesApi'
import { useConfigStore } from '../store/configStore'
import { scopedKey } from '../workspace/configScope'
import type { RequestScope } from '../api/baseUrl'

/**
 * The built-in plus the configured dimensions (empty while loading). The built-in
 * `feedback_type` comes with English labels; `select` swaps in the current
 * language's (re-run when the language changes), so every chip, picker and chart
 * shows them translated. The cache keeps the wire copy.
 */
export function useDimensionsConfig(scope: RequestScope = 'workspace') {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  const { t } = useTranslation('common')
  const select = useCallback((config: DimensionsConfig) => localizeBuiltinDimensions(config, t), [t])
  return useQuery({
    // `scope` (workspace/configScope.ts): the current workspace's (default) or, for Administration, the deployment's.
    queryKey: scopedKey(dimensionsConfigKey(), scope),
    queryFn: () => dimensionsApi.getConfig(scope),
    enabled: !!apiEndpoint,
    select,
  })
}

/** Source profiles: full rows for admins, `{id, label, restricted}` for everyone else; in `scope` as above. */
export function useSourceProfiles(scope: RequestScope = 'workspace') {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  return useQuery({
    queryKey: scopedKey(sourceProfilesKey(), scope),
    queryFn: () => sourceProfilesApi.getProfiles(scope),
    enabled: !!apiEndpoint,
  })
}
