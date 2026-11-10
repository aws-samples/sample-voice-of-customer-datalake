/**
 * @fileoverview `utils/displayLabels` bound to the configured categories and
 * source profiles (the shared, cached queries — no extra requests per
 * consumer). While those load, or for a user who cannot read them, every
 * label falls back to the humanised id, so a label is never blank.
 *
 * @module hooks/useDisplayLabels
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BUILT_IN_SOURCES, categoryLabel, humanizeId, keywordLabel, sourceLabel, subcategoryLabel, themeLabel } from '../utils/displayLabels'
import { useCategoriesConfig } from './useCategories'
import { useSourceProfiles } from './useDimensions'

export interface DisplayLabels {
  readonly category: (id: string) => string
  readonly subcategory: (id: string, parent?: string) => string
  readonly theme: (category: string, subcategory?: string | null) => string
  readonly source: (id: string) => string
  /** A trending keyword: a category id reads as its category, any other keyword as written. */
  readonly keyword: (keyword: string) => string
  /** Persona types and any other id without configured names. */
  readonly plain: (id: string) => string
}

export function useDisplayLabels(): DisplayLabels {
  const { data: config } = useCategoriesConfig()
  const { data: profiles } = useSourceProfiles()
  const { t } = useTranslation('common')
  const otherLabel = t('categoryOther')
  return useMemo(() => {
    const categories = config?.categories ?? []
    const sources = profiles ?? []
    const builtIn = (id: string) => (Object.hasOwn(BUILT_IN_SOURCES, id) ? t(`builtInSources.${id}`) : undefined)
    return {
      category: (id) => categoryLabel(id, categories, otherLabel),
      subcategory: (id, parent) => subcategoryLabel(id, parent, categories),
      theme: (category, subcategory) => themeLabel(category, subcategory, categories),
      source: (id) => sourceLabel(id, sources, builtIn),
      keyword: (keyword) => keywordLabel(keyword, categories),
      plain: humanizeId,
    }
  }, [config, profiles, otherLabel, t])
}
