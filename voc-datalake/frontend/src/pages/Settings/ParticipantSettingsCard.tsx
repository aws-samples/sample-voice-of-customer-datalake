/**
 * @fileoverview Administration → Privacy & access → Users → "Participant email"
 * (docs/participants.md): whether people outside the company domains may be added as
 * participants, the daily send cap, the sender name — and, read-only, whether email sending
 * is configured (`-c emailFrom`) and the board link to share. The company domains themselves
 * moved to Privacy & access → Boards (linked from here); this card never sends them, so its
 * partial save cannot overwrite them. Admin-only save.
 * @module pages/Settings/ParticipantSettingsCard
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Loader2, Mail, Save } from 'lucide-react'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import Switch from '../../components/Switch/Switch'
import { MAX_SENDER_NAME_CHARS, participantsApi, participantsKeys } from '../../api/participantsApi'
import type { SettingsInput } from '../../api/participantsApi'
import { MAX_DAILY_SEND_CAP } from '../../api/participantsSchema'
import type { SettingsView } from '../../api/participantsSchema'
import { useIsAdmin } from '../../store/authStore'
import { participantErrorMessage } from '../Participants/participantErrors'
import { canonicalSearch } from './adminTabs'
import { SettingsLoading, SettingsNotice } from './SettingsNotice'
import { useSaveEngagementSettings } from './useSaveEngagementSettings'

/** What this card saves: every engagement setting but the company domains (Boards owns them). */
type CardInput = Omit<SettingsInput, 'company_domains'>

const BOARDS_SECTION = `/admin?${canonicalSearch({ tab: 'access', section: 'boards' })}`

function isValidCap(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_DAILY_SEND_CAP
}

function StatusLines({ view }: Readonly<{ view: SettingsView }>) {
  const { t } = useTranslation('participants')
  return (
    <dl className="space-y-1 text-sm">
      <div className="flex flex-wrap gap-2">
        <dt className="text-muted">{t('settings.emailSending')}</dt>
        <dd className="text-text">{view.email_enabled ? t('settings.emailOn') : t('settings.emailOff')}</dd>
      </div>
      <div className="flex flex-wrap gap-2">
        <dt className="text-muted">{t('settings.boardLink')}</dt>
        <dd className="text-text break-all">
          {view.board_enabled && view.board_url !== ''
            ? <a href={view.board_url} className="link" target="_blank" rel="noreferrer">{view.board_url}</a>
            : t('settings.boardOff')}
        </dd>
      </div>
    </dl>
  )
}

/** The company domains, read-only: they are edited in Privacy & access → Boards. */
function CompanyDomainsLine({ domains }: Readonly<{ domains: readonly string[] }>) {
  const { t } = useTranslation('settings')
  return (
    <p className="text-sm text-muted">
      {domains.length === 0 ? t('boards.participantCard.noDomains') : t('boards.participantCard.domains', { list: domains.join(', ') })}
      {' '}
      <Link to={BOARDS_SECTION} className="link">{t('boards.participantCard.editInBoards')}</Link>
    </p>
  )
}

/**
 * The form is keyed on `updated_at`, so a save (which bumps it) remounts it with the stored values.
 * Whether the last save succeeded therefore lives in the card (`saved`), not in the form's mutation.
 */
function SettingsForm({ view, canSave, saved, onSavedChange }: Readonly<{
  view: SettingsView; canSave: boolean; saved: boolean; onSavedChange: (saved: boolean) => void
}>) {
  const { t } = useTranslation('participants')
  const [draft, setDraft] = useState<CardInput>(() => ({
    allow_external_people: view.settings.allow_external_people,
    daily_send_cap: view.settings.daily_send_cap,
    sender_name: view.settings.sender_name,
  }))
  const save = useSaveEngagementSettings(onSavedChange)
  const patch = (next: Partial<CardInput>) => {
    onSavedChange(false)
    setDraft((current) => ({ ...current, ...next }))
  }
  // The API refuses an empty From name (participants_settings: 1-80 characters).
  const senderOk = draft.sender_name.trim() !== ''
  const ready = canSave && isValidCap(draft.daily_send_cap) && senderOk && !save.isPending

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) save.mutate({ ...draft, sender_name: draft.sender_name.trim() }) }}>
      <CompanyDomainsLine domains={view.settings.company_domains} />
      <Switch label={t('settings.allowExternal')} checked={draft.allow_external_people} disabled={!canSave}
        onChange={(allowed) => patch({ allow_external_people: allowed })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-sm font-medium text-text mb-1">{t('settings.dailyCap')}</span>
          <input type="number" min={1} max={MAX_DAILY_SEND_CAP} step={1} value={Number.isNaN(draft.daily_send_cap) ? '' : draft.daily_send_cap} disabled={!canSave}
            aria-invalid={!isValidCap(draft.daily_send_cap)}
            onChange={(e) => patch({ daily_send_cap: e.target.valueAsNumber })} className="input w-full" />
          <span className="block text-xs text-muted mt-1">{t('settings.dailyCapHint', { max: MAX_DAILY_SEND_CAP })}</span>
        </label>
        <label className="block">
          <span className="block text-sm font-medium text-text mb-1">{t('settings.senderName')}</span>
          <input value={draft.sender_name} maxLength={MAX_SENDER_NAME_CHARS} disabled={!canSave}
            required aria-invalid={!senderOk}
            onChange={(e) => patch({ sender_name: e.target.value })} className="input w-full" />
          <span className="block text-xs text-muted mt-1">{t('settings.senderNameHint')}</span>
        </label>
      </div>
      {canSave ? (
        <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-3 py-2">
          <button type="submit" disabled={!ready} className="btn btn-primary btn-sm">
            {save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
            {t('actions.save')}
          </button>
          {save.isError ? <p role="alert" className="text-sm text-danger">{participantErrorMessage(save.error, t)}</p> : null}
          {saved ? <p role="status" className="text-sm text-ok">{t('settings.saved')}</p> : null}
        </StickyActionBar>
      ) : null}
    </form>
  )
}

export default function ParticipantSettingsCard() {
  const { t } = useTranslation('participants')
  const isAdmin = useIsAdmin()
  const view = useQuery({ queryKey: participantsKeys.settings(), queryFn: participantsApi.getSettings })
  const [saved, setSaved] = useState(false)
  return (
    <section className="card space-y-4" aria-labelledby="participant-settings-title">
      <div className="space-y-1">
        <h2 id="participant-settings-title" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-strong">
          <Mail className="text-accent" size={16} aria-hidden /> {t('settings.title')}
        </h2>
        <p className="text-sm text-muted">{t('settings.description')}</p>
      </div>
      {view.isPending ? <SettingsLoading text={t('loading')} /> : null}
      {view.isError ? <SettingsNotice text={t('settings.loadFailed')} /> : null}
      {view.data === undefined ? null : (
        <>
          <StatusLines view={view.data} />
          <SettingsForm key={view.data.settings.updated_at ?? 'defaults'} view={view.data} canSave={isAdmin}
            saved={saved} onSavedChange={setSaved} />
        </>
      )}
    </section>
  )
}
