/**
 * @fileoverview `save_brand_settings` preview: the MERGED result that will be
 * saved (current settings with the proposed fields replacing theirs), with the
 * replaced fields marked — the same merge the executor performs. The base it
 * merged into is recorded on the card's shown record, and the executor saves
 * only if the settings still equal it (see shown.ts).
 *
 * @module assistant/approvals/previews/BrandSettingsPreview
 */
import { useContext, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchBrandSettings, mergeBrandSettings } from '../executors'
import { ShownContext, recordBrandBase } from '../shown'
import { FieldChanges } from './FieldChangesPreview'
import type { SaveBrandSettingsArgs } from '../schemas'

const BRAND_PREVIEW_KEY = ['assistant', 'brand-settings-preview'] as const

export function BrandSettingsPreview({ args }: Readonly<{ args: SaveBrandSettingsArgs }>) {
  const { t } = useTranslation('assistantTools')
  const shown = useContext(ShownContext)
  // A card-local key: the Settings page caches the raw response under
  // ['brand-settings'], so sharing it could render a base other than the one
  // fetched (and normalised) here.
  const { data, isLoading } = useQuery({
    queryKey: BRAND_PREVIEW_KEY,
    queryFn: fetchBrandSettings,
    retry: false,
  })
  useEffect(() => {
    if (shown !== null) recordBrandBase(shown, data)
  }, [shown, data])
  if (data === undefined) {
    return <FieldChanges updates={args} current={undefined} isLoading={isLoading} />
  }
  const merged = mergeBrandSettings(data, args)
  return (
    <div className="space-y-1">
      <p className="text-[12px] text-muted">{t('preview.brandMerged')}</p>
      <FieldChanges updates={{ ...merged }} current={{ ...data }} isLoading={false} />
    </div>
  )
}
