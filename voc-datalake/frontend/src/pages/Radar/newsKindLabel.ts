/**
 * @fileoverview The name of a Radar news kind ("Company news") in the UI language, for its badge,
 * a filter chip or the filter's empty line (NewsKind, ReleasesTimeline).
 * @module pages/Radar/newsKindLabel
 */
import { useTranslation } from 'react-i18next'
import type { RadarNewsKind } from '../../api/radarNewsFields'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const KIND_LABELS: Record<RadarNewsKind, { labelKey: string }> = {
  release: { labelKey: 'radar:releases.kinds.release' },
  announcement: { labelKey: 'radar:releases.kinds.announcement' },
  promotion: { labelKey: 'radar:releases.kinds.promotion' },
  partnership: { labelKey: 'radar:releases.kinds.partnership' },
  news: { labelKey: 'radar:releases.kinds.news' },
}

export function useNewsKindLabel(): (kind: RadarNewsKind) => string {
  const { t } = useTranslation('radar')
  return (kind) => t(KIND_LABELS[kind].labelKey)
}
