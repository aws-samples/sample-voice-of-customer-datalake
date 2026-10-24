/**
 * @fileoverview Administration → System → Logs → Alerts (admin-only): turn the operational
 * CloudWatch alarms on or off, and manage who gets their email.
 *
 * No alarm exists until an admin turns alerting on (each one is billed every
 * hour it exists); turning it off deletes them. Recipients are SNS email
 * subscriptions: AWS mails each one a confirmation link, and the row reads
 * "pending confirmation" until it is clicked. Server side: `/logs/alerts*`,
 * `lambda/shared/ops_alerts*.py`.
 *
 * @module pages/Settings/AlertsCard
 */
import { useState } from 'react'
import type { SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDecimal } from '../../utils/numberFormat'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Loader2, Mail, Plus, Trash2 } from 'lucide-react'
import { alertsApi, alertsKey } from '../../api/alertsApi'
import type { AlertRecipient, AlertsStatus } from '../../api/alertsApi'
import { messageKeyForStatus } from '../../api/apiErrorStatus'
import SwitchField from '../../components/SwitchField/SwitchField'
import { useIsAdmin } from '../../store/authStore'
import { formatDateTime } from '../../utils/dateUtils'
import { SettingsLoading, SettingsNotice } from './SettingsNotice'

/** CloudWatch's standard-resolution price per alarm metric per month (us-east-1). */
const USD_PER_ALARM_METRIC_MONTH = 0.1
/** MAX_EMAIL_LENGTH in shared/ops_alerts.py. */
const MAX_EMAIL_LENGTH = 254

const ERROR_KEYS = [
  { status: 400, messageKey: 'logs.alerts.errors.invalid' },
  { status: 404, messageKey: 'logs.alerts.errors.notFound' },
  { status: 409, messageKey: 'logs.alerts.errors.pending' },
] as const
const GENERIC_ERROR = { messageKey: 'logs.alerts.errors.failed' } as const

export default function AlertsCard() {
  const isAdmin = useIsAdmin()
  if (!isAdmin) return null
  return <AlertsCardBody />
}

function AlertsCardBody() {
  const { t } = useTranslation('settings')
  const { data, isLoading, isError } = useQuery({ queryKey: alertsKey(), queryFn: alertsApi.get })

  return (
    <section className="card" aria-labelledby="alerts-card-title">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Bell className="text-accent" size={16} aria-hidden="true" />
        <h3 id="alerts-card-title" className="min-w-0 break-words hyphens-auto text-base font-semibold tracking-tight text-text-strong">
          {t('logs.alerts.title')}
        </h3>
        {data?.configured === true && (
          <span className={data.enabled ? 'badge badge-ok' : 'badge badge-muted'}>
            {data.enabled ? t('logs.alerts.on') : t('logs.alerts.off')}
          </span>
        )}
      </div>
      <AlertsCardContent status={data} isLoading={isLoading} isError={isError} />
    </section>
  )
}

interface AlertsCardContentProps {
  readonly status: AlertsStatus | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

function AlertsCardContent({ status, isLoading, isError }: AlertsCardContentProps) {
  const { t } = useTranslation('settings')
  if (isLoading) return <SettingsLoading text={t('logs.alerts.loading')} />
  if (isError || status === undefined) return <SettingsNotice text={t('logs.alerts.errors.load')} />
  if (!status.configured) return <SettingsNotice text={t('logs.alerts.notConfigured')} />
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('logs.alerts.description')}</p>
      <AlertingSwitch status={status} />
      <RecipientsPanel status={status} />
    </div>
  )
}

function useRefreshAlerts() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: alertsKey() })
}

function AlertingSwitch({ status }: { readonly status: AlertsStatus }) {
  const { t, i18n } = useTranslation('settings')
  const refresh = useRefreshAlerts()
  const toggle = useMutation({ mutationFn: (enabled: boolean) => alertsApi.setEnabled(enabled), onSettled: refresh })
  const cost = formatDecimal(status.billed_metric_count * USD_PER_ALARM_METRIC_MONTH, i18n.language, 2)
  const hasConfirmed = status.subscribers.some((recipient) => recipient.status === 'confirmed')

  return (
    <div className="space-y-2">
      <SwitchField
        checked={status.enabled}
        disabled={toggle.isPending}
        onChange={(enabled) => toggle.mutate(enabled)}
        label={t('logs.alerts.switchLabel')}
        hint={t('logs.alerts.costHint', { alarms: status.expected_alarm_count, cost })}
      />
      {status.enabled && <p className="text-xs text-warn">{t('logs.alerts.offDeletesAlarms')}</p>}
      {status.updated_at !== undefined && (
        <p className="text-xs text-muted">
          {t('logs.alerts.updated', { when: formatDateTime(status.updated_at, i18n.language), who: status.updated_by ?? '' })}
        </p>
      )}
      {status.enabled && !hasConfirmed && <SettingsNotice text={t('logs.alerts.nobodyListening')} />}
      {toggle.isError && <ErrorLine error={toggle.error} />}
    </div>
  )
}

function ErrorLine({ error }: { readonly error: unknown }) {
  const { t } = useTranslation('settings')
  return <p role="alert" className="text-sm text-danger">{t(messageKeyForStatus(error, ERROR_KEYS, GENERIC_ERROR))}</p>
}

function RecipientsPanel({ status }: { readonly status: AlertsStatus }) {
  const { t } = useTranslation('settings')
  const refresh = useRefreshAlerts()
  const remove = useMutation({ mutationFn: (email: string) => alertsApi.removeRecipient(email), onSettled: refresh })

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-text">{t('logs.alerts.recipients')}</h4>
      {status.subscribers.length === 0 ? (
        <p className="text-sm text-muted">{t('logs.alerts.noRecipients')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {status.subscribers.map((recipient) => (
            <RecipientRow
              key={recipient.email}
              recipient={recipient}
              removing={remove.isPending && remove.variables === recipient.email}
              onRemove={() => remove.mutate(recipient.email)}
            />
          ))}
        </ul>
      )}
      {remove.isError && <ErrorLine error={remove.error} />}
      <AddRecipientForm atCap={status.subscribers.length >= status.max_subscribers} max={status.max_subscribers} />
    </div>
  )
}

interface RecipientRowProps {
  readonly recipient: AlertRecipient
  readonly removing: boolean
  readonly onRemove: () => void
}

function RecipientRow({ recipient, removing, onRemove }: RecipientRowProps) {
  const { t } = useTranslation('settings')
  const confirmed = recipient.status === 'confirmed'
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <Mail size={14} className="text-muted flex-shrink-0" aria-hidden="true" />
      <span className="text-sm font-mono text-text break-all flex-1 min-w-0">{recipient.email}</span>
      <span className={confirmed ? 'badge badge-ok' : 'badge badge-warn'}>
        {confirmed ? t('logs.alerts.confirmed') : t('logs.alerts.pending')}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={removing}
        onClick={onRemove}
        aria-label={t('logs.alerts.remove', { email: recipient.email })}
        title={t('logs.alerts.remove', { email: recipient.email })}
      >
        {removing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
      </button>
    </li>
  )
}

function AddRecipientForm({ atCap, max }: { readonly atCap: boolean; readonly max: number }) {
  const { t } = useTranslation('settings')
  const refresh = useRefreshAlerts()
  const [email, setEmail] = useState('')
  const add = useMutation({
    mutationFn: (address: string) => alertsApi.addRecipient(address),
    onSuccess: () => setEmail(''),
    onSettled: refresh,
  })

  const submit = (event: SyntheticEvent) => {
    event.preventDefault()
    const trimmed = email.trim()
    if (trimmed !== '') add.mutate(trimmed)
  }

  return (
    <form onSubmit={submit} className="space-y-1">
      <div className="flex items-center gap-2">
        <label htmlFor="alerts-add-email" className="sr-only">{t('logs.alerts.emailLabel')}</label>
        <input
          id="alerts-add-email"
          type="email"
          className="input flex-1"
          value={email}
          maxLength={MAX_EMAIL_LENGTH}
          disabled={atCap || add.isPending}
          placeholder={t('logs.alerts.emailPlaceholder')}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" className="btn btn-secondary btn-sm flex items-center gap-1.5" disabled={atCap || add.isPending || email.trim() === ''}>
          {add.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
          {t('logs.alerts.add')}
        </button>
      </div>
      <p className="text-xs text-muted">{atCap ? t('logs.alerts.atCap', { max }) : t('logs.alerts.confirmHint')}</p>
      {add.isError && <ErrorLine error={add.error} />}
    </form>
  )
}
