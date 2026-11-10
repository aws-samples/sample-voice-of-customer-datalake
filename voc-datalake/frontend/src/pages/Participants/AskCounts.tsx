/**
 * @fileoverview An ask's counters: recipients, sent, failed, skipped (unsubscribed), responded.
 * @module pages/Participants/AskCounts
 */
import { useTranslation } from 'react-i18next'
import type { AskCounts as Counts } from '../../api/participantsSchema'
import { formatCount } from '../../utils/numberFormat'

function Counter({ label, value }: Readonly<{ label: string; value: number }>) {
  const { i18n } = useTranslation()
  return (
    <div className="rounded-lg border border-border px-2 py-1.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-semibold text-text-strong tabular-nums">{formatCount(value, i18n.language)}</dd>
    </div>
  )
}

export default function AskCounts({ counts }: Readonly<{ counts: Counts }>) {
  const { t } = useTranslation('participants')
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <Counter label={t('asks.counts.recipients')} value={counts.recipients} />
      <Counter label={t('asks.counts.sent')} value={counts.sent} />
      <Counter label={t('asks.counts.failed')} value={counts.failed} />
      <Counter label={t('asks.counts.skipped')} value={counts.skipped} />
      <Counter label={t('asks.counts.responded')} value={counts.responded} />
    </dl>
  )
}
