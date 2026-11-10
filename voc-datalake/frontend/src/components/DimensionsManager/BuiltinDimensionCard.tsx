/**
 * @fileoverview A built-in dimension (`feedback_type`) in Settings → Dimensions:
 * read-only (defined in code, present on every deployment, always inferred by the
 * enrichment model), its values listed with translated labels and what each covers,
 * plus the backfill for reviews stored before it existed.
 *
 * @module components/DimensionsManager/BuiltinDimensionCard
 */
import { useTranslation } from 'react-i18next'
import { Lock } from 'lucide-react'
import FeedbackTypeBackfill from './FeedbackTypeBackfill'
import type { Dimension } from '../../api/dimensionsSchema'

export default function BuiltinDimensionCard({ dimension }: Readonly<{ dimension: Dimension }>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionsManager.builtin' })
  return (
    <section className="rounded-lg border border-border p-3 sm:p-4 space-y-3" aria-label={dimension.label}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">{dimension.label}</h3>
        <code className="text-xs text-muted font-mono">{dimension.key}</code>
        <span className="badge badge-muted" title={t('badgeHint')}>
          <Lock size={12} aria-hidden="true" />
          {t('badge')}
        </span>
      </div>
      <p className="text-sm text-muted">{t('description')}</p>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {dimension.values.map((value) => (
          <li key={value.name} className="min-w-0 text-xs">
            <span className="font-medium text-text-strong">{value.label ?? value.name}</span>
            {value.description !== undefined && <span className="text-text"> · {value.description}</span>}
          </li>
        ))}
      </ul>
      <FeedbackTypeBackfill />
    </section>
  )
}
