/**
 * @fileoverview The display name of each colour theme. Kiro, Nord, Dracula and Quick
 * are proper nouns, shown as they are in every language; "High contrast" is translated.
 * @module components/ThemePicker/themeNames
 */
import { useTranslation } from 'react-i18next'
import type { ColorThemeId } from '../../theme/themeCatalog'

/** Every theme's name in the current language. */
export function useThemeNames(): Readonly<Record<ColorThemeId, string>> {
  const { t } = useTranslation('common')
  return {
    kiro: 'Kiro',
    nord: 'Nord',
    dracula: 'Dracula',
    highcontrast: t('theme.highContrast'),
    quick: 'Quick',
  }
}
