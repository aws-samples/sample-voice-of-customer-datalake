/**
 * @fileoverview Status pill for one Settings model test (POST /settings/model/test).
 * Tones and texts per status live in modelTestStatus.ts.
 */
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { STATUS_META, useModelTestFigures } from './modelTestStatus'
import type { ModelTestResult } from '../../api/modelTestSchema'


interface ModelTestPillProps {
  readonly result: ModelTestResult | undefined
  readonly testing: boolean
  /** Hide the explanatory line (compact table cells). */
  readonly compact?: boolean
}

export default function ModelTestPill({ result, testing, compact = false }: ModelTestPillProps) {
  const { t } = useTranslation('settings')
  const figures = useModelTestFigures()

  if (testing) {
    return (
      <span className="badge badge-muted inline-flex items-center gap-1" role="status">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" /> {t('aiModel.test.testing')}
      </span>
    )
  }
  if (!result) {
    return <span className="badge badge-muted">{t('aiModel.test.notTested')}</span>
  }

  const meta = STATUS_META[result.status]
  const Icon = meta.icon
  // A compact pill sits in a table whose own columns carry latency and quota.
  const extras = result.status === 'available' && !compact
    ? [figures.latency(result.latency_ms), result.quota ? figures.tokensPerMinute(result.quota.tokens_per_minute) : '']
      .filter((part) => part !== '')
    : []
  return (
    <span className="inline-flex flex-col gap-0.5 min-w-0" role="status" data-status={result.status}>
      <span className={`badge badge-${meta.tone} inline-flex items-center gap-1 self-start`}>
        <Icon size={12} aria-hidden="true" />
        {t(meta.labelKey)}
        {extras.length > 0 && <span className="font-mono">{extras.join(' · ')}</span>}
      </span>
      {!compact && result.status !== 'available' && (
        <span className="text-xs text-muted">{t(meta.detailKey)}</span>
      )}
    </span>
  )
}
