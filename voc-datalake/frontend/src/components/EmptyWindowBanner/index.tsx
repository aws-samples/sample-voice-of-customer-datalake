/**
 * @fileoverview Banner shown when a page falls back from an empty selected time
 * range to the most recent data that exists.
 *
 * Kept as a shared component so the Dashboard and Categories pages present the
 * fallback identically. The copy names the date the data is from, so the user is
 * never shown data silently relabelled as their selected range — the fallback is
 * explicit, which is the whole point of surfacing it rather than widening the
 * window behind their back.
 *
 * Styling matches the established amber "hint" convention (partial-window /
 * partial-counts hints) rather than an error red: this is informational, not a
 * failure.
 */
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface EmptyWindowBannerProps {
  /** The date the fallback data is from, 'YYYY-MM-DD'. */
  readonly date: string
}

export default function EmptyWindowBanner({ date }: EmptyWindowBannerProps) {
  const { t } = useTranslation('common')
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700"
    >
      <Info size={16} className="mt-0.5 flex-shrink-0" />
      <span>{t('emptyWindowFallback', { date })}</span>
    </div>
  )
}
