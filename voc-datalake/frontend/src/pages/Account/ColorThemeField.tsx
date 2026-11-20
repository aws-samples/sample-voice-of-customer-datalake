/**
 * @fileoverview Account → Preferences: my colour theme. "Workspace default" follows the
 * theme an administrator picked for everyone (Administration → General); the five themes
 * are my own pick, kept in this browser (theme/themeStore.ts `voc-theme`).
 * @module pages/Account/ColorThemeField
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import ThemePicker from '../../components/ThemePicker/ThemePicker'
import type { ThemeOption } from '../../components/ThemePicker/ThemePicker'
import { useThemeNames } from '../../components/ThemePicker/themeNames'
import { COLOR_THEME_IDS, isColorThemeChoice, WORKSPACE_THEME_CHOICE } from '../../theme/themeCatalog'
import { useThemeStore } from '../../theme/themeStore'

export default function ColorThemeField() {
  const { t } = useTranslation('common')
  const labelId = useId()
  const names = useThemeNames()
  const colorTheme = useThemeStore((s) => s.colorTheme)
  const workspaceTheme = useThemeStore((s) => s.workspaceTheme)
  const setColorTheme = useThemeStore((s) => s.setColorTheme)
  const options: ThemeOption[] = [
    { value: WORKSPACE_THEME_CHOICE, theme: workspaceTheme, label: t('theme.workspaceDefault', { name: names[workspaceTheme] }) },
    ...COLOR_THEME_IDS.map((id) => ({ value: id, theme: id, label: names[id] })),
  ]
  return (
    <div className="space-y-2">
      <div>
        <span id={labelId} className="text-sm text-text">{t('theme.colorTheme')}</span>
        <p className="text-xs text-muted">{t('theme.colorThemeHint')}</p>
      </div>
      <ThemePicker
        options={options}
        value={colorTheme}
        labelledBy={labelId}
        onChange={(value) => { if (isColorThemeChoice(value)) setColorTheme(value) }}
      />
    </div>
  )
}
