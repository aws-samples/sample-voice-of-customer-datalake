/**
 * @fileoverview The morning brief settings form (on/off, time, language,
 * custom instructions, email), shown on Account → Morning brief
 * (docs/account-vs-admin.md), and Home's one-click "Subscribe to the morning
 * brief" call to action while the reader is not subscribed (no settings
 * fields on Home: it subscribes with the defaults and links to Account).
 * On Account, until the reader subscribes, the Subscribe control (pick the hour,
 * then Subscribe) and the brief language show; once subscribed, the settings show and the
 * on/off switch turns it off — never a Subscribe button and an "on" state at once.
 * The brief language defaults to "Same as the app" (docs/briefing.md → "Which language").
 * The time zone is the browser's. Email goes only to
 * the account's own verified address.
 * @module pages/Home/brief/BriefSettings
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { BellRing, MailCheck, MailQuestion } from 'lucide-react'
import { MAX_INSTRUCTIONS_CHARS } from '../../../api/briefingApi'
import { isSupportedLanguage, languageNames, supportedLanguages } from '../../../i18n/languages'
import type { SupportedLanguage } from '../../../i18n/languages'
import Switch from '../../../components/Switch/Switch'
import { accountTabPath } from '../../Account/accountSections'
import { browserTimeZone } from './briefCards'
import CloseCardButton from './CloseCardButton'
import type { BriefPreferenceChanges, BriefPreferences } from '../../../api/briefingApi'
import type { BriefPreferencesResult } from './useBriefPreferences'

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

function hourLabel(hour: number, language: string): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })
}

function HourSelect({ value, onChange, disabled }: Readonly<{ value: number; onChange: (hour: number) => void; disabled: boolean }>) {
  const { t, i18n } = useTranslation('briefing')
  const id = useId()
  return (
    <div className="flex items-center gap-2 text-sm text-text">
      <label htmlFor={id}>{t('settings.time')}</label>
      <select id={id} className="select w-auto" value={value} disabled={disabled}
        onChange={(e) => { onChange(Number(e.target.value)) }}>
        {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour, i18n.language)}</option>)}
      </select>
    </div>
  )
}

interface SubscribeCardProps {
  description: string
  children: ReactNode
  /** Home only: the X that closes the card (Account's card has none). */
  onClose?: () => void
}

/** The "Subscribe to the morning brief" card: title, one line, then the actions. */
function SubscribeCard({ description, children, onClose }: Readonly<SubscribeCardProps>) {
  const { t } = useTranslation('briefing')
  return (
    <div className="relative space-y-3 rounded-lg border border-accent/30 bg-accent-subtle p-4">
      {onClose !== undefined && <CloseCardButton cardTitle={t('subscribe.title')} onClose={onClose} />}
      <h3 className="flex items-center gap-2 pr-8 font-semibold text-text-strong">
        <BellRing size={16} aria-hidden="true" className="text-accent" />
        {t('subscribe.title')}
      </h3>
      <p className="text-sm text-muted">{description}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

/** The app's language when the brief supports it (the brief follows it unless the reader chose one). */
function useAppLanguage(): SupportedLanguage | null {
  const { i18n } = useTranslation('briefing')
  return isSupportedLanguage(i18n.language) ? i18n.language : null
}

/** What Subscribe saves: an explicitly chosen brief language is kept, otherwise the app's is recorded as `ui`. */
function subscribeChanges(preferences: BriefPreferences, appLanguage: SupportedLanguage | null, hour: number): BriefPreferenceChanges {
  const base = { enabled: true, hour, time_zone: browserTimeZone() }
  if (preferences.language_source === 'chosen' || appLanguage === null) return base
  return { ...base, language: appLanguage, language_source: 'ui' }
}

function SubscribeButton({ settings, hour }: Readonly<{ settings: BriefPreferencesResult; hour: number }>) {
  const { t } = useTranslation('briefing')
  const appLanguage = useAppLanguage()
  return (
    <button type="button" className="btn btn-primary btn-sm" disabled={settings.isSaving}
      onClick={() => { settings.save(subscribeChanges(settings.preferences, appLanguage, hour)) }}>
      {t('subscribe.button')}
    </button>
  )
}

/**
 * Home's one-click "Subscribe to the morning brief" (shown while not subscribed):
 * the default hour (the stored one, else 8:00) in the browser's time zone, and a
 * link to Account → Morning brief for everything else. No settings fields here:
 * personal preferences live on Account (docs/account-vs-admin.md). The X
 * (`onClose`) takes the card off Home for this user.
 */
export function BriefSubscribe({ settings, onClose }: Readonly<{ settings: BriefPreferencesResult; onClose: () => void }>) {
  const { t, i18n } = useTranslation('briefing')
  const { hour } = settings.preferences
  const description = t('subscribe.oneClick', { time: hourLabel(hour, i18n.language), zone: browserTimeZone() })
  return (
    <SubscribeCard description={description} onClose={onClose}>
      <SubscribeButton settings={settings} hour={hour} />
      <Link to={accountTabPath('briefing')} className="link text-sm">{t('subscribe.customise')}</Link>
    </SubscribeCard>
  )
}

/** Account's call to action atop the form while not subscribed: pick the hour, then Subscribe. */
function SubscribeWithHour({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  const { t } = useTranslation('briefing')
  const [hour, setHour] = useState(settings.preferences.hour)
  return (
    <SubscribeCard description={t('subscribe.description', { zone: browserTimeZone() })}>
      <HourSelect value={hour} onChange={setHour} disabled={settings.isSaving} />
      <SubscribeButton settings={settings} hour={hour} />
    </SubscribeCard>
  )
}

function EmailStatus({ preferences, id }: Readonly<{ preferences: BriefPreferences; id: string }>) {
  const { t } = useTranslation('briefing')
  if (!preferences.email || preferences.email_status === 'off') {
    return <p id={id} className="text-xs text-muted">{t('settings.emailHint')}</p>
  }
  const confirmed = preferences.email_status === 'confirmed'
  const Icon = confirmed ? MailCheck : MailQuestion
  return (
    <p role="status" className={confirmed ? 'flex items-center gap-2 text-xs text-ok' : 'flex items-center gap-2 text-xs text-warn'}>
      <Icon size={14} aria-hidden="true" />
      {confirmed ? t('settings.emailConfirmed') : t('settings.emailPending')}
    </p>
  )
}

function Instructions({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  const { t } = useTranslation('briefing')
  const id = useId()
  const [text, setText] = useState(settings.preferences.instructions)
  const tooLong = text.trim().length > MAX_INSTRUCTIONS_CHARS
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium text-text">{t('settings.instructions')}</label>
      <textarea id={id} className="input min-h-20 w-full" value={text} aria-invalid={tooLong}
        onChange={(e) => { setText(e.target.value) }} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={tooLong ? 'text-xs text-danger' : 'text-xs text-muted'}>{t('settings.instructionsHint')}</p>
        <button type="button" className="btn btn-secondary btn-sm" disabled={settings.isSaving || tooLong}
          onClick={() => { settings.save({ instructions: text.trim() }) }}>
          {t('settings.save')}
        </button>
      </div>
    </div>
  )
}

/** The picker's value for "Same as the app" (the brief follows the UI language, `language_source: 'ui'`). */
const SAME_AS_APP = ''

/** The PUT for a picked option: "Same as the app" goes back to `ui`, a language is an explicit choice. */
function languageChanges(value: string, appLanguage: SupportedLanguage | null): BriefPreferenceChanges | null {
  if (value === SAME_AS_APP) {
    return appLanguage === null ? { language_source: 'ui' } : { language: appLanguage, language_source: 'ui' }
  }
  return isSupportedLanguage(value) ? { language: value, language_source: 'chosen' } : null
}

/**
 * "Brief language": "Same as the app (<the UI language>)" by default, or one language
 * picked explicitly, which then wins for Refresh, the scheduled brief and the email.
 */
function LanguageSelect({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  const { t } = useTranslation('briefing')
  const id = useId()
  const appLanguage = useAppLanguage()
  const { preferences } = settings
  const value = preferences.language_source === 'chosen' ? preferences.language : SAME_AS_APP
  return (
    <div className="flex items-center gap-2 text-sm text-text">
      <label htmlFor={id}>{t('settings.language')}</label>
      <select id={id} className="select w-auto" value={value} disabled={settings.isSaving}
        onChange={(e) => {
          const changes = languageChanges(e.target.value, appLanguage)
          if (changes !== null) settings.save(changes)
        }}>
        <option value={SAME_AS_APP}>
          {t('settings.languageSameAsApp', { language: languageNames[appLanguage ?? preferences.language] })}
        </option>
        {supportedLanguages.map((code) => <option key={code} value={code}>{languageNames[code]}</option>)}
      </select>
    </div>
  )
}

function EmailSetting({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  const { t } = useTranslation('briefing')
  const hintId = useId()
  const { preferences, isSaving } = settings
  return (
    <div className="space-y-1">
      <Switch label={t('settings.email')} checked={preferences.email}
        disabled={isSaving} describedBy={hintId}
        onChange={(email) => { settings.save({ email }) }} />
      <EmailStatus preferences={preferences} id={hintId} />
    </div>
  )
}

function SaveFailed({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  const { t } = useTranslation('briefing')
  return settings.saveFailed ? <p role="alert" className="text-sm text-danger">{t('settings.saveFailed')}</p> : null
}

/** The settings of a subscribed reader: the on/off switch turns it off, no Subscribe button. */
function SettingsForm({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  const { t } = useTranslation('briefing')
  const { preferences, isSaving } = settings
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Switch label={t('settings.enabled')} checked={preferences.enabled} disabled={isSaving}
          onChange={(enabled) => { settings.save({ enabled, time_zone: browserTimeZone() }) }} />
        <HourSelect value={preferences.hour} disabled={isSaving}
          onChange={(hour) => { settings.save({ hour, time_zone: browserTimeZone() }) }} />
        <LanguageSelect settings={settings} />
      </div>
      <EmailSetting settings={settings} />
      {/* Keyed by the stored text: a save (or a reload) resets the field to what the server holds. */}
      <Instructions key={preferences.instructions} settings={settings} />
      <SaveFailed settings={settings} />
    </div>
  )
}

/** Not subscribed: the Subscribe control (no "on" switch beside it) and the brief language, which Refresh uses too. */
function NotSubscribed({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  return (
    <div className="space-y-4">
      <SubscribeWithHour settings={settings} />
      <LanguageSelect settings={settings} />
      <SaveFailed settings={settings} />
    </div>
  )
}

/** The Subscribe control or the settings, or a loading line while the preference is fetched. */
export default function BriefSettings({ settings }: Readonly<{ settings: BriefPreferencesResult }>) {
  const { t } = useTranslation('briefing')
  if (settings.isLoading) return <p className="text-sm text-muted">{t('settings.loading')}</p>
  return settings.preferences.enabled ? <SettingsForm settings={settings} /> : <NotSubscribed settings={settings} />
}
