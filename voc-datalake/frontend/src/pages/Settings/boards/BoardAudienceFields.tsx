/**
 * @fileoverview The board editor's audience: who may sign in to the board and post. "Company" uses
 * the company domains; "Specific people" takes allowed domains (chips) and email addresses (one per
 * line, checked, counted); "Anyone" admits any email address that verifies itself, with a plain
 * warning about what that means and the per-person limits.
 * @module pages/Settings/boards/BoardAudienceFields
 */
import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { participantsApi, participantsKeys } from '../../../api/participantsApi'
import DomainChipsInput from '../DomainChipsInput'
import { BOARD_LIMITS } from '../../../api/boardFields'
import { AUDIENCE_MODES } from '../../../api/featureBoardsSchema'
import type { AudienceMode } from '../../../api/featureBoardsSchema'
import { AUDIENCE_COPY } from './boardCopy'
import DescribedRadios from './DescribedRadios'
import { parseEmails } from './boardDraft'
import type { BoardDraft } from './boardDraft'

type AudiencePatch = Partial<Pick<BoardDraft, 'mode' | 'domains' | 'emailsText'>>

function CompanyDomainsNote() {
  const { t } = useTranslation('settings')
  const view = useQuery({ queryKey: participantsKeys.settings(), queryFn: participantsApi.getSettings })
  const domains = view.data?.settings.company_domains ?? []
  return (
    <p className="text-xs text-muted">
      {domains.length === 0 ? t('boards.audience.noCompanyDomains') : t('boards.audience.companyDomains', { list: domains.join(', ') })}
    </p>
  )
}

function EmailsField({ text, disabled, onChange }: Readonly<{ text: string; disabled: boolean; onChange: (text: string) => void }>) {
  const { t } = useTranslation('settings')
  const id = useId()
  const errorId = useId()
  const { valid, invalid } = parseEmails(text)
  const tooMany = valid.length > BOARD_LIMITS.emails
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-text">{t('boards.audience.emails')}</label>
      <textarea id={id} rows={4} className="input w-full font-mono text-sm" value={text} disabled={disabled}
        placeholder="name@example.com" aria-invalid={invalid.length > 0 || tooMany}
        aria-describedby={invalid.length > 0 ? errorId : undefined} onChange={(e) => onChange(e.target.value)} />
      <p className="text-xs text-muted">{t('boards.audience.emailsCount', { count: valid.length, max: BOARD_LIMITS.emails })}</p>
      {invalid.length > 0 ? (
        <p id={errorId} className="text-xs text-danger break-all">{t('boards.audience.emailsInvalid', { list: invalid.join(', ') })}</p>
      ) : null}
    </div>
  )
}

function AnyoneWarning() {
  const { t } = useTranslation('settings')
  return (
    <p role="note" className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn-subtle p-2 text-sm text-text">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      {t('boards.audience.anyoneWarning')}
    </p>
  )
}

function ModeDetails({ draft, disabled, onChange }: Readonly<{
  draft: BoardDraft; disabled: boolean; onChange: (patch: AudiencePatch) => void
}>) {
  const { t } = useTranslation('settings')
  if (draft.mode === 'company') return <CompanyDomainsNote />
  if (draft.mode === 'anyone') return <AnyoneWarning />
  return (
    <div className="space-y-3">
      <DomainChipsInput label={t('boards.audience.domains')} domains={draft.domains} max={BOARD_LIMITS.domains}
        disabled={disabled} onChange={(domains) => onChange({ domains })} />
      <EmailsField text={draft.emailsText} disabled={disabled} onChange={(emailsText) => onChange({ emailsText })} />
    </div>
  )
}

export default function BoardAudienceFields({ draft, disabled, onChange }: Readonly<{
  draft: BoardDraft; disabled: boolean; onChange: (patch: AudiencePatch) => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold tracking-tight text-text-strong mb-1">{t('boards.audience.title')}</legend>
      <DescribedRadios<AudienceMode> options={AUDIENCE_MODES} copy={AUDIENCE_COPY} value={draft.mode} disabled={disabled}
        className="grid gap-2 sm:grid-cols-3" onChange={(mode) => onChange({ mode })} />
      <ModeDetails draft={draft} disabled={disabled} onChange={onChange} />
    </fieldset>
  )
}
