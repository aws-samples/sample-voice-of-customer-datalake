/**
 * @fileoverview Account → "Setup checklist": where the onboarding buddy comes
 * back after Hide / Skip / Don't show again, and where the start page ("Open the
 * dashboard when I sign in") is switched off again. Reads and writes the same
 * server-side preference as Home (`useOnboardingPreference`), so it costs one
 * GET (shared cache) and no step queries.
 *
 * @module pages/Account/OnboardingSection
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ListChecks } from 'lucide-react'
import { useOnboardingPreference } from '../Home/onboarding/useOnboardingPreference'
import StartPageSwitch from '../Home/onboarding/StartPageSwitch'
import { Section } from './ProfileSections'
import type { OnboardingPreference } from '../../api/onboardingApi'

function useStatusText(preference: OnboardingPreference): string {
  const { t, i18n } = useTranslation('common')
  if (preference.visible) return t('account.onboardingShown')
  if (preference.state === 'hidden' && preference.hidden_until !== undefined) {
    const when = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(preference.hidden_until))
    return t('account.onboardingHiddenUntil', { when })
  }
  return t('account.onboardingOff')
}

export default function OnboardingSection() {
  const { t } = useTranslation('common')
  const { preference, isResolving, setState, setStartPage, isSaving, saveFailed } = useOnboardingPreference()
  const status = useStatusText(preference)
  return (
    <Section icon={ListChecks} title={t('account.onboardingTitle')} description={t('account.onboardingHint')}>
      {/* Polite live region: the text changes in place when the choice is saved. */}
      <p className="text-sm text-text" aria-live="polite">{isResolving ? '…' : status}</p>
      {saveFailed && <p role="alert" className="text-sm text-danger">{t('dashboard:home.buddy.saveFailed')}</p>}
      <div>
        {preference.visible ? (
          <Link to="/" className="btn btn-secondary btn-sm">{t('nav.home')}</Link>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={isSaving || isResolving} onClick={() => setState('active')}>
            {t('account.onboardingShow')}
          </button>
        )}
      </div>
      <StartPageSwitch startPage={preference.start_page} onChange={setStartPage} disabled={isSaving || isResolving} />
    </Section>
  )
}
