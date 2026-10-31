/**
 * @fileoverview The Data quality section's source profile: per source, how its feedback is rated, how it
 * reads (sentiment) and how long it is, one facet at a time. Counts come from the aggregator's profile
 * counters (lambda/shared/source_profile.py); feedback stored before they existed is not profiled, and the
 * section says how much. Ported from PR #429 by @aws-bryan (his per-source profile card).
 * @module pages/DataExplorer/DataQualitySectionProfile
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { formatCount, formatPercent } from '../../utils/numberFormat'
import { shareOf } from '../../api/dataQualitySchema'
import { PROFILE_FACETS, PROFILE_VALUES } from '../../api/dataQualityProfileSchema'
import type { OverallQuality, SourceQuality } from '../../api/dataQualitySchema'
import type { ProfileFacet, SourceProfile } from '../../api/dataQualityProfileSchema'

/** Static keys, so the i18n audit sees every label the profile uses. */
const FACET_LABEL_KEYS = {
  rating: 'dataQuality.profile.facets.rating',
  sentiment: 'dataQuality.profile.facets.sentiment',
  length: 'dataQuality.profile.facets.length',
} as const satisfies Record<ProfileFacet, string>

const VALUE_LABEL_KEYS: Readonly<Record<ProfileFacet, Readonly<Record<string, string>>>> = {
  rating: {
    '5': 'dataQuality.profile.rating.5', '4': 'dataQuality.profile.rating.4', '3': 'dataQuality.profile.rating.3',
    '2': 'dataQuality.profile.rating.2', '1': 'dataQuality.profile.rating.1', none: 'dataQuality.profile.rating.none',
  },
  sentiment: {
    positive: 'dataQuality.profile.sentiment.positive', neutral: 'dataQuality.profile.sentiment.neutral',
    mixed: 'dataQuality.profile.sentiment.mixed', negative: 'dataQuality.profile.sentiment.negative',
    other: 'dataQuality.profile.sentiment.other',
  },
  length: {
    short: 'dataQuality.profile.length.short', medium: 'dataQuality.profile.length.medium',
    long: 'dataQuality.profile.length.long', very_long: 'dataQuality.profile.length.very_long',
  },
}

function ProfileRow({ label, profile, facet, strong = false }: Readonly<{
  label: string; profile: SourceProfile; facet: ProfileFacet; strong?: boolean
}>) {
  const { i18n } = useTranslation()
  return (
    <tr className={clsx('border-t border-border', strong && 'font-semibold')}>
      <th scope="row" className="px-3 py-2 text-left font-medium text-text-strong">{label}</th>
      {PROFILE_VALUES[facet].map((value) => {
        const count = profile[facet][value] ?? 0
        return (
          <td key={value} className="px-3 py-2 text-right tabular-nums">
            {formatCount(count, i18n.language)}
            <span className="ml-1 text-xs text-muted">({formatPercent(shareOf(count, profile.profiled), i18n.language)})</span>
          </td>
        )
      })}
      <td className="px-3 py-2 text-right tabular-nums">{formatCount(profile.profiled, i18n.language)}</td>
    </tr>
  )
}

function FacetSwitch({ facet, onChange }: Readonly<{ facet: ProfileFacet; onChange: (facet: ProfileFacet) => void }>) {
  const { t } = useTranslation('dataExplorer')
  return (
    <div role="group" aria-label={t('dataQuality.profile.facetGroup')} className="flex flex-wrap gap-2">
      {PROFILE_FACETS.map((option) => (
        <button key={option} type="button" aria-pressed={option === facet} onClick={() => onChange(option)}
          className={clsx('btn btn-sm', option === facet ? 'btn-primary' : 'btn-secondary')}>
          {t(FACET_LABEL_KEYS[option])}
        </button>
      ))}
    </div>
  )
}

interface ProfileProps {
  readonly sources: readonly SourceQuality[]
  readonly overall: OverallQuality
  readonly sourceName: (source: string) => string
}

export default function DataQualitySectionProfile({ sources, overall, sourceName }: ProfileProps) {
  const { t, i18n } = useTranslation('dataExplorer')
  const [facet, setFacet] = useState<ProfileFacet>('rating')
  const unprofiled = Math.max(overall.total - overall.profile.profiled, 0)
  return (
    <div className="space-y-3" data-testid="data-quality-profile">
      <div>
        <h3 className="text-sm font-semibold text-text-strong">{t('dataQuality.profile.title')}</h3>
        <p className="text-sm text-muted mt-1">{t('dataQuality.profile.description')}</p>
      </div>
      {unprofiled > 0 && (
        <p className="text-xs text-muted">
          {t('dataQuality.profile.notProfiled', { share: formatPercent(shareOf(unprofiled, overall.total), i18n.language) })}
        </p>
      )}
      <FacetSwitch facet={facet} onChange={setFacet} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('dataQuality.profile.tableCaption', { facet: t(FACET_LABEL_KEYS[facet]) })}</caption>
          <thead>
            <tr className="text-muted">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('dataQuality.columns.source')}</th>
              {PROFILE_VALUES[facet].map((value) => (
                <th key={value} scope="col" className="px-3 py-2 text-right font-medium">{t(VALUE_LABEL_KEYS[facet][value] ?? value)}</th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('dataQuality.profile.profiled')}</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((row) => (
              <ProfileRow key={row.source} label={sourceName(row.source)} profile={row.profile} facet={facet} />
            ))}
            {sources.length > 1 && (
              <ProfileRow label={t('dataQuality.allSources')} profile={overall.profile} facet={facet} strong />
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
