/**
 * @fileoverview Boards → Company domains: the email domains that count as the company's. A board
 * whose audience is "company" admits people at them, and participants outside them may be refused
 * (docs/participants.md). Moved here from the participant-email card; same setting, saved alone
 * (`PUT /participants/settings {company_domains}`). Admin-only save.
 * @module pages/Settings/boards/CompanyDomainsCard
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Building2, Loader2, Save } from 'lucide-react'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { MAX_COMPANY_DOMAINS, participantsApi, participantsKeys } from '../../../api/participantsApi'
import { useIsAdmin } from '../../../store/authStore'
import DomainChipsInput from '../DomainChipsInput'
import { SettingsLoading, SettingsNotice } from '../SettingsNotice'
import { useSaveEngagementSettings } from '../useSaveEngagementSettings'
import { boardErrorMessage } from './boardCopy'

function DomainsForm({ stored, canSave, saved, onSavedChange }: Readonly<{
  stored: readonly string[]; canSave: boolean; saved: boolean; onSavedChange: (saved: boolean) => void
}>) {
  const { t } = useTranslation('settings')
  const [domains, setDomains] = useState<readonly string[]>(stored)
  const save = useSaveEngagementSettings(onSavedChange)
  const dirty = JSON.stringify(domains) !== JSON.stringify(stored)
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (canSave && dirty) save.mutate({ company_domains: [...domains] }) }}>
      <DomainChipsInput label={t('boards.domains.label')} domains={domains} max={MAX_COMPANY_DOMAINS} disabled={!canSave}
        onChange={(next) => { onSavedChange(false); setDomains(next) }} />
      <p className="text-xs text-muted">{t('boards.domains.hint')}</p>
      {canSave ? (
        <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-3 py-2">
          <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || save.isPending}>
            {save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
            {t('boards.domains.save')}
          </button>
          {save.isError ? <p role="alert" className="text-sm text-danger">{boardErrorMessage(save.error, t)}</p> : null}
          {saved && !dirty ? <p role="status" className="text-sm text-ok">{t('boards.saved')}</p> : null}
        </StickyActionBar>
      ) : null}
    </form>
  )
}

export default function CompanyDomainsCard() {
  const { t } = useTranslation('settings')
  const isAdmin = useIsAdmin()
  const view = useQuery({ queryKey: participantsKeys.settings(), queryFn: participantsApi.getSettings })
  const [saved, setSaved] = useState(false)
  const stored = view.data?.settings.company_domains
  return (
    <section className="card space-y-3" aria-labelledby="board-domains-title">
      <div className="space-y-1">
        <h2 id="board-domains-title" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-text-strong">
          <Building2 className="text-accent" size={16} aria-hidden /> {t('boards.domains.title')}
        </h2>
        <p className="text-sm text-muted">{t('boards.domains.description')}</p>
      </div>
      {view.isPending ? <SettingsLoading text={t('boards.loading')} /> : null}
      {view.isError ? <SettingsNotice text={t('boards.domains.loadFailed')} /> : null}
      {stored === undefined ? null : (
        // Keyed on the stored list: a save (or another admin's) restarts the form from it.
        <DomainsForm key={stored.join(',')} stored={stored} canSave={isAdmin} saved={saved} onSavedChange={setSaved} />
      )}
    </section>
  )
}
