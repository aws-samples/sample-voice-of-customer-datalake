/**
 * @fileoverview How a Radar brand's search language reads: its name when one is set, else
 * "Auto (from the domain: Polish)" with the language the server derived (or plain "Auto (from
 * the domain)" for a brand not saved yet). Names are in the UI language.
 * @module pages/Settings/useLanguageSummary
 */
import { useTranslation } from 'react-i18next'
import { languageName } from '../../utils/languageName'
import type { RadarLanguage } from '../../api/radarNewsFields'

/** The label of a brand's language: set (`language`), or Auto with what the server derived (`effective`). */
export function useLanguageSummary(): (language: RadarLanguage | null, effective: RadarLanguage | null) => string {
  const { t, i18n } = useTranslation('radar')
  return (language, effective) => {
    if (language !== null) return languageName(language, i18n.language)
    return effective === null ? t('brands.languageAutoNew') : t('brands.languageAuto', { language: languageName(effective, i18n.language) })
  }
}
