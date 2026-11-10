/**
 * @fileoverview Account → "Morning brief": the reader's own brief settings
 * (on/off, time, language, instructions, email). Their only home
 * (docs/account-vs-admin.md): Home links here from the brief's Settings button
 * and keeps just the compact subscribe call to action, reading the same
 * self-scoped preference (`/settings/my-briefing`, one shared cache entry).
 *
 * @module pages/Account/BriefSection
 */
import { useTranslation } from 'react-i18next'
import { Sunrise } from 'lucide-react'
import BriefSettings from '../Home/brief/BriefSettings'
import { useBriefPreferences } from '../Home/brief/useBriefPreferences'
import { Section } from './ProfileSections'

export default function BriefSection() {
  const { t } = useTranslation('common')
  const settings = useBriefPreferences()
  return (
    <Section icon={Sunrise} title={t('account.nav.briefing')} description={t('account.briefHint')}>
      <BriefSettings settings={settings} />
    </Section>
  )
}
