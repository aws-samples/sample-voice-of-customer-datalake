/**
 * @fileoverview "Open the dashboard when I sign in": the per-user start page
 * as an on/off switch (design system `switch`). On Home and on the Account page;
 * both read and write the same server-side preference (`useOnboardingPreference`).
 *
 * @module pages/Home/onboarding/StartPageSwitch
 */
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { StartPage } from '../../../api/onboardingApi'

interface Props {
  startPage: StartPage
  onChange: (page: StartPage) => void
  disabled: boolean
}

export default function StartPageSwitch({ startPage, onChange, disabled }: Readonly<Props>) {
  const { t } = useTranslation('dashboard')
  const on = startPage === 'dashboard'
  return (
    // The wrapping label names the switch: no id wiring needed.
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text">
      <span className="relative inline-flex items-center">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked ? 'dashboard' : 'home')}
          className="peer sr-only"
        />
        {/* The input stays the accessible control; these spans are its visual track and knob. */}
        <span
          aria-hidden="true"
          className={clsx(
            'switch peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
            on && 'switch-on',
          )}
        >
          <span className="switch-knob" />
        </span>
      </span>
      <span>{t('home.buddy.startOnDashboard')}</span>
    </label>
  )
}
