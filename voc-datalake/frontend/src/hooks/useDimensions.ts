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

/**
 * The built-in plus the configured dimensions (empty while loading). The built-in
 * `feedback_type` comes with English labels; `select` swaps in the current
 * language's (re-run when the language changes), so every chip, picker and chart
 * shows them translated. The cache keeps the wire copy.
 */
export function useDimensionsConfig() {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  const { t } = useTranslation('common')
  const select = useCallback((config: DimensionsConfig) => localizeBuiltinDimensions(config, t), [t])
  return useQuery({
    queryKey: dimensionsConfigKey(),
    queryFn: () => dimensionsApi.getConfig(),
    enabled: !!apiEndpoint,
    select,
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
