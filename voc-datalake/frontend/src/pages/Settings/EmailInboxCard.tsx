/**
 * @fileoverview Administration → Sources → Email inbox (admin-only): whether the inbox is deployed
 * (`-c inboundEmailDomain`), the addresses it answers, the personal-data policy, today's
 * counters (accepted, dropped by reason, deduplicated) and the daily caps.
 * Server side: `/settings/email-inbox*`, docs/email-intake.md.
 * @module pages/Settings/EmailInboxCard
 */
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox, Layers, Mail } from 'lucide-react'
import { DEDUPE_REASONS, DROP_REASONS, emailInboxApi, emailInboxKey } from '../../api/emailInboxApi'
import type { EmailInboxStatus, EmailInboxToday } from '../../api/emailInboxApi'
import { useIsAdmin } from '../../store/authStore'
import { SettingsLoading, SettingsNotice } from './SettingsNotice'
import EmailInboxCapsForm from './EmailInboxCapsForm'

export default function EmailInboxCard() {
  const isAdmin = useIsAdmin()
  if (!isAdmin) return null
  return <EmailInboxCardBody />
}

function EmailInboxCardBody() {
  const { t } = useTranslation('emailInbox')
  const { data, isLoading, isError } = useQuery({ queryKey: emailInboxKey(), queryFn: emailInboxApi.get })
  return (
    <section className="card" aria-labelledby="email-inbox-title">
      <div className="flex items-center gap-2 mb-1">
        <Inbox className="text-accent" size={16} aria-hidden="true" />
        <h2 id="email-inbox-title" className="text-lg font-semibold tracking-tight text-text-strong">{t('title')}</h2>
        {data !== undefined && (
          <span className={data.enabled ? 'badge badge-ok' : 'badge badge-muted'}>{data.enabled ? t('on') : t('off')}</span>
        )}
      </div>
      <p className="text-sm text-muted mb-4">{t('description')}</p>
      <CardContent status={data} isLoading={isLoading} isError={isError} />
    </section>
  )
}

interface CardContentProps {
  readonly status: EmailInboxStatus | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

function CardContent({ status, isLoading, isError }: CardContentProps) {
  const { t } = useTranslation('emailInbox')
  if (isLoading) return <SettingsLoading text={t('loading')} />
  if (isError || status === undefined) return <SettingsNotice text={t('errors.load')} />
  if (!status.enabled) return <SettingsNotice text={t('notDeployed')} />
  return (
    <div className="space-y-5">
      <Addresses status={status} />
      <p className="text-sm text-text">{t(`pii.${status.pii}`)}</p>
      {!status.feedback_type_dimension && <DimensionPrompt />}
      <TodayCounters today={status.today} />
      <EmailInboxCapsForm key={status.updated_at ?? 'defaults'} caps={status.caps} />
    </div>
  )
}

function Addresses({ status }: { readonly status: EmailInboxStatus }) {
  const { t } = useTranslation('emailInbox')
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-text">{t('addresses')}</h3>
      <ul className="flex flex-wrap gap-2">
        {status.addresses.map((address) => (
          <li key={address} className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1">
            <Mail size={14} className="text-muted" aria-hidden="true" />
            <span className="text-sm font-mono text-text">{address}</span>
          </li>
        ))}
      </ul>
      {status.rule_set_needs_activation && <SettingsNotice text={t('ruleSetInactive', { ruleSet: status.rule_set ?? '' })} />}
    </div>
  )
}

function DimensionPrompt() {
  const { t } = useTranslation('emailInbox')
  const queryClient = useQueryClient()
  const create = useMutation({
    mutationFn: () => emailInboxApi.createFeedbackTypeDimension(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: emailInboxKey() }),
  })
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
      <Layers size={16} className="text-accent" aria-hidden="true" />
      <p className="text-sm text-text flex-1">{t('dimension.missing')}</p>
      <button type="button" className="btn btn-secondary btn-sm" disabled={create.isPending} onClick={() => create.mutate()}>
        {t('dimension.create')}
      </button>
      {create.isError && <p role="alert" className="text-sm text-danger w-full">{t('errors.dimension')}</p>}
    </div>
  )
}

function sum(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0)
}

function ReasonList({ reasons, counts }: { readonly reasons: readonly string[]; readonly counts: Record<string, number> }) {
  const { t } = useTranslation('emailInbox')
  const nonZero = reasons.filter((reason) => (counts[reason] ?? 0) > 0)
  if (nonZero.length === 0) return null
  return (
    <ul className="text-xs text-muted space-y-0.5">
      {nonZero.map((reason) => (
        <li key={reason}>{t(`reasons.${reason}`)}: {counts[reason] ?? 0}</li>
      ))}
    </ul>
  )
}

function Counter({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold text-text-strong tabular-nums">{value}</dd>
    </div>
  )
}

function TodayCounters({ today }: { readonly today: EmailInboxToday }) {
  const { t } = useTranslation('emailInbox')
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-text">{t('today.title')}</h3>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Counter label={t('today.accepted')} value={today.accepted} />
        <Counter label={t('today.deduped')} value={sum(today.deduped)} />
        <Counter label={t('today.dropped')} value={sum(today.dropped)} />
        <Counter label={t('today.deferred')} value={today.deferred} />
        <Counter label={t('today.modelCalls')} value={today.model_calls} />
      </dl>
      <ReasonList reasons={DEDUPE_REASONS} counts={today.deduped} />
      <ReasonList reasons={DROP_REASONS} counts={today.dropped} />
    </div>
  )
}
