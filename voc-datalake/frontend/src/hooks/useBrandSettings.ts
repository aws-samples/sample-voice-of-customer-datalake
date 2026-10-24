/**
 * @fileoverview The shared `GET /settings/brand` query.
 *
 * The sidebar names the brand under the app name. It used to read only the
 * persisted config store, which nothing filled until the admin page loaded the
 * brand settings, so most pages said "Configure brand" and the subtitle changed
 * to the real brand only after /admin had been visited (E2E F12). The app shell
 * now reads the brand once through this hook; the Settings page reads the same
 * cache entry (`brandSettingsKey`), so it costs no second request.
 *
 * @module hooks/useBrandSettings
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '../api/client'
import { useConfigStore } from '../store/configStore'

/** Query key of the brand settings. Single source of truth for Layout and Settings. */
export const brandSettingsKey = () => ['brand-settings'] as const

/** The one field the shell needs, validated: an error payload or a non-string name reads as unknown. */
const BrandNameSchema = z.object({ brand_name: z.string() })

/** The stored brand name, or null while unknown (loading, failed, or an error payload). */
function brandNameOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && 'error' in raw) return null
  const parsed = BrandNameSchema.safeParse(raw)
  return parsed.success ? parsed.data.brand_name : null
}

/**
 * The brand name to show, and whether it is still being fetched.
 *
 * Shows the persisted name at once (no flash on a reload), replaces it with the
 * stored one as soon as that arrives, and writes the stored one back to the
 * config store so every other reader of `config.brandName` agrees.
 */
export function useBrandName(apiEndpoint: string): { brandName: string; isLoading: boolean } {
  const { config, setConfig } = useConfigStore()
  const persisted = config.brandName
  const { data, isLoading } = useQuery({
    queryKey: brandSettingsKey(),
    queryFn: () => api.getBrandSettings(),
    enabled: apiEndpoint !== '',
  })
  const stored = brandNameOf(data)

  useEffect(() => {
    if (stored !== null && stored !== persisted) setConfig({ brandName: stored })
  }, [stored, persisted, setConfig])

  return { brandName: stored ?? persisted, isLoading }
}
