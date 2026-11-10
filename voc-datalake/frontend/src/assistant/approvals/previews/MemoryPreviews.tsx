/**
 * @fileoverview Memory approval previews. The scope is always explicit —
 * a company memory is visible to EVERYONE, so the card says so — and
 * `update_company_memory` shows the "N people said X — now Y?" change.
 *
 * @module assistant/approvals/previews/MemoryPreviews
 */
import { Building2, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RememberArgs, UpdateCompanyMemoryArgs } from '../memorySchemas'

export function RememberPreview({ args }: Readonly<{ args: RememberArgs }>) {
  const { t } = useTranslation('assistantTools')
  const company = args.scope === 'company'
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className={company ? 'badge badge-warn' : 'badge badge-muted'}>
          {company ? <Building2 size={12} aria-hidden="true" /> : <User size={12} aria-hidden="true" />}
          {' '}{t(`preview.memory.scope.${args.scope}`)}
        </span>
        <span className="badge badge-muted">{t(`preview.memory.kind.${args.kind}`)}</span>
        {args.retention !== undefined && (
          <span className="text-[12px] text-muted">
            {t(`preview.memory.retention.${args.retention}`, { date: args.expires_at ?? '' })}
          </span>
        )}
      </p>
      <p className="text-sm text-text-strong">{args.statement}</p>
      {company && <p className="text-[12px] text-muted">{t('preview.memory.companyVisible')}</p>}
    </div>
  )
}

export function CompanyMemoryChangePreview({ args }: Readonly<{ args: UpdateCompanyMemoryArgs }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <div className="space-y-2">
      {args.supporters !== undefined && (
        <p className="text-[12px] text-muted">{t('preview.memory.supporters', { count: args.supporters })}</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <div className="rounded-sm bg-danger-subtle px-1.5 py-1 text-muted">
          <p className="text-[12px]">{t('preview.before')}</p>
          <p>{args.previous_statement}</p>
        </div>
        <div className="rounded-sm bg-ok-subtle px-1.5 py-1 text-text-strong">
          <p className="text-[12px] text-muted">{t('preview.after')}</p>
          <p>{args.statement}</p>
        </div>
      </div>
      <p className="text-[12px] text-muted">{t('preview.memory.reason')}: <span className="text-text">{args.reason}</span></p>
      <p className="text-[12px] text-muted">{t('preview.memory.forEveryone')}</p>
    </div>
  )
}
