/**
 * @fileoverview One brand's releases, newest first, each with its citations
 * (titles + links). Web search results must keep their sources (AgentCore
 * acceptable use), so every release links what it was found in — each page
 * once, over https (`uniqueCitations`).
 * @module pages/Radar/ReleasesTimeline
 */
import { ExternalLink, Rocket } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import SectionTitle from './SectionTitle'
import { citationLabel, uniqueCitations } from './radarFormat'
import { formatCalendarDay } from '../../utils/dateUtils'
import type { RadarRelease } from '../../api/radarSchema'

function Citations({ release }: Readonly<{ release: RadarRelease }>) {
  const { t } = useTranslation('radar')
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 mt-1" aria-label={t('releases.sources')}>
      {uniqueCitations(release.urls, release.titles).map(({ url, title }) => (
        // A citation label is often a URL path ("example-air.example/changelog/2026-…"):
        // it may break anywhere so it never pushes the page wider (390 px / 200 %).
        <li key={url} className="min-w-0 max-w-full">
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="link text-xs inline-flex max-w-full items-center gap-1">
            <span data-testid="citation-label" className="min-w-0 [overflow-wrap:anywhere]">{citationLabel(url, title)}</span>
            <ExternalLink size={12} className="flex-shrink-0" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  )
}

export default function ReleasesTimeline({ releases }: Readonly<{ releases: readonly RadarRelease[] }>) {
  const { t, i18n } = useTranslation('radar')
  return (
    <section className="card" aria-labelledby="radar-releases">
      <SectionTitle id="radar-releases" icon={Rocket}>{t('releases.title')}</SectionTitle>
      {releases.length === 0 ? <p className="text-sm text-muted">{t('releases.empty')}</p> : (
        <ol className="space-y-4 border-l border-border pl-4">
          {releases.map((release) => (
            <li key={release.release_id}>
              <p className="text-xs text-muted flex flex-wrap items-center gap-2">
                <time dateTime={release.release_date}>{formatCalendarDay(release.release_date, i18n.language)}</time>
                {release.date_approximate ? <span>{t('releases.approximate')}</span> : null}
                <span className={release.source_kind === 'official' ? 'badge-accent' : 'badge-muted'}>
                  {release.source_kind === 'official' ? t('releases.official') : t('releases.thirdParty')}
                </span>
                <span>{t('releases.mentions', { count: release.mentions })}</span>
              </p>
              <h3 className="text-sm font-semibold text-text-strong mt-1">{release.feature}</h3>
              {release.summary === '' ? null : <p className="text-sm text-text mt-1">{release.summary}</p>}
              <Citations release={release} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
