/**
 * @fileoverview Administration → AI: this month's voice minutes (7.69.00, docs/voice-personas.md), only on a
 * deployment with `features.voice` and only for administrators (`GET /projects/voice/usage` is admin-only): the
 * minutes used of the monthly budget (`-c voiceMonthlyMinutes`), the sessions, their estimated cost, the
 * conversations live now against the deployment's cap, the limits per session and per person, and the model. Read
 * only: the budget and the limits are deployment settings.
 *
 * @module pages/Settings/VoiceUsageCard
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AudioLines } from 'lucide-react'
import { voiceKeys, voiceSessionsApi } from '../../api/voiceSessionsApi'
import type { VoiceUsage } from '../../api/voiceSessionsApi'
import { isVoiceAvailable } from '../../runtimeConfig'
import { formatCents } from '../ProjectDetail/voice/voiceFormat'

function UsageRows({ usage }: Readonly<{ usage: VoiceUsage }>) {
  const { t, i18n } = useTranslation('settings')
  const rows: ReadonlyArray<readonly [string, string]> = [
    [t('voiceUsage.minutes'), t('voiceUsage.ofTotal', { used: Math.round(usage.minutes_used), total: usage.monthly_minutes })],
    [t('voiceUsage.sessions'), String(usage.sessions)],
    [t('voiceUsage.cost'), formatCents(usage.cost_cents, i18n.language)],
    [t('voiceUsage.live'), t('voiceUsage.ofTotal', { used: usage.live_sessions, total: usage.max_concurrent })],
    [t('voiceUsage.sessionMinutes'), String(usage.session_minutes)],
    [t('voiceUsage.dailySessions'), String(usage.daily_sessions)],
    [t('voiceUsage.model'), usage.model_id],
  ]
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b border-border py-1">
          <dt className="text-muted">{label}</dt>
          <dd className="font-mono text-text-strong">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export default function VoiceUsageCard({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('settings')
  const enabled = isAdmin && isVoiceAvailable()
  const usage = useQuery({ queryKey: voiceKeys.usage(), queryFn: () => voiceSessionsApi.getUsage(), enabled })
  if (!enabled) return null
  return (
    <section className="card mt-4" aria-labelledby="voice-usage-title">
      <div className="mb-1 flex items-center gap-2">
        <AudioLines size={18} className="text-accent" aria-hidden />
        <h2 id="voice-usage-title" className="text-lg font-semibold">{t('voiceUsage.title')}</h2>
      </div>
      <p className="mb-3 text-xs text-muted">{t('voiceUsage.intro', { month: usage.data?.month ?? '' })}</p>
      {usage.isError ? <p role="alert" className="text-sm text-danger">{t('voiceUsage.failed')}</p> : null}
      {usage.data === undefined && !usage.isError ? <p role="status" className="text-sm text-muted">{t('voiceUsage.loading')}</p> : null}
      {usage.data === undefined ? null : <UsageRows usage={usage.data} />}
    </section>
  )
}
