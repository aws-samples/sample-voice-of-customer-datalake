/**
 * @fileoverview Header control that cycles the theme preference
 * system → light → dark (KiroCrew `cycleMode` order).
 * @module components/ThemeToggle
 */
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { nextPreference, useThemeStore } from '../../theme/themeStore'
import type { ThemePreference } from '../../theme/themeStore'
import type { LucideIcon } from 'lucide-react'

const ICONS: Record<ThemePreference, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

export default function ThemeToggle() {
  const { t } = useTranslation()
  const preference = useThemeStore((s) => s.preference)
  const cyclePreference = useThemeStore((s) => s.cyclePreference)
  const Icon = ICONS[preference]
  // Literal t() calls so scripts/i18n-check.mjs can see every key.
  const labels: Record<ThemePreference, string> = {
    system: t('theme.system'),
    light: t('theme.light'),
    dark: t('theme.dark'),
  }
  const label = t('theme.toggle', { current: labels[preference], next: labels[nextPreference(preference)] })

  return (
    <button
      type="button"
      onClick={cyclePreference}
      className="icon-btn focus-ring border border-border bg-bg-elevated"
      aria-label={label}
      title={label}
      data-theme-pref={preference}
    >
      <Icon size={16} aria-hidden />
    </button>
  )
}
