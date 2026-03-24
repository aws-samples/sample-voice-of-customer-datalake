/**
 * @fileoverview Language switcher dropdown component.
 * @module components/LanguageSwitcher
 */

import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { supportedLanguages, languageNames, changeLanguage } from '../../i18n/config'
import type { SupportedLanguage } from '../../i18n/config'

export default function LanguageSwitcher() {
  const { i18n } = useTranslation()

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    changeLanguage(e.target.value)
  }

  return (
    <div className="flex items-center gap-2">
      <Globe size={16} className="text-gray-400 flex-shrink-0" />
      <select
        value={i18n.language}
        onChange={handleChange}
        className="input text-sm py-1.5"
        aria-label="Select language"
      >
        {supportedLanguages.map((lang: SupportedLanguage) => (
          <option key={lang} value={lang}>
            {languageNames[lang]}
          </option>
        ))}
      </select>
    </div>
  )
}
