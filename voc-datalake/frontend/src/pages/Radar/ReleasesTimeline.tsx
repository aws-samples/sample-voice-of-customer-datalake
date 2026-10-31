/**
 * @fileoverview News and releases, newest first, each with its kind and its citations (titles +
 * links), above them a kind filter (client-side; NewsKind).
 * Web search results must keep their sources (AgentCore acceptable use), so every
 * release links what it was found in — each page once, over https (`uniqueCitations`).
 * One brand's releases on the brand view; on "All brands" the combined feed, where
 * each release also names its brand (a chip that opens that brand).
 * @module pages/Radar/ReleasesTimeline
 */
import { ExternalLink, Rocket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FoundViaMarker, NewsKindBadge, NewsKindFilter } from './NewsKind'
import { useNewsKindLabel } from './newsKindLabel'
import SectionTitle from './SectionTitle'
import { citationLabel, uniqueCitations } from './radarFormat'
import { formatCalendarDay } from '../../utils/dateUtils'
import type { RadarBrandRef, RadarRelease } from '../../api/radarSchema'
import type { NewsKindChoice } from './NewsKind'
import { httpHref } from '../../utils/httpHref'

/** A release, with the brand it is about when the feed mixes brands. */
type TimelineRelease = RadarRelease & { readonly brand?: RadarBrandRef }
type OnBrand = (key: string) => void

function Citations({ release }: Readonly<{ release: RadarRelease }>) {
  const { t } = useTranslation('radar')
  // Only web links are listed: a citation that is not an http(s) URL is dropped (FE-7).
  const citations = uniqueCitations(release.urls, release.titles)
    .flatMap(({ url, title }) => { const href = httpHref(url); return href === undefined ? [] : [{ url, href, title }] })
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 mt-1" aria-label={t('releases.sources')}>
      {citations.map(({ url, href, title }) => (
        // A citation label is often a URL path ("example-air.example/changelog/2026-…"):
        // it may break anywhere so it never pushes the page wider (390 px / 200 %).
        <li key={url} className="min-w-0 max-w-full">
          <a href={href} target="_blank" rel="noopener noreferrer"
            className="link text-xs inline-flex max-w-full items-center gap-1">
            <span data-testid="citation-label" className="min-w-0 [overflow-wrap:anywhere]">{citationLabel(url, title)}</span>
            <ExternalLink size={12} className="flex-shrink-0" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  )
}

/** A brand chip: a long brand name wraps inside the chip, never past the card. */
const BRAND_CHIP = 'badge badge-muted font-medium text-text-strong max-w-full [overflow-wrap:anywhere]'

/** The brand a release of the combined feed is about: a chip that opens that brand's view. */
function BrandChip({ brand, onBrand }: Readonly<{ brand: RadarBrandRef; onBrand?: OnBrand }>) {
  const { t } = useTranslation('radar')
  if (onBrand === undefined) return <span className={BRAND_CHIP} data-testid="release-brand">{brand.label}</span>
  return (
    <button type="button" className={`${BRAND_CHIP} hover:text-accent`} data-testid="release-brand"
      aria-label={t('all.openBrand', { brand: brand.label })} onClick={() => onBrand(brand.key)}>
      {brand.label}
    </button>
  )
}

function ReleaseItem({ release, onBrand }: Readonly<{ release: TimelineRelease; onBrand?: OnBrand }>) {
  const { t, i18n } = useTranslation('radar')
  return (
    <li data-testid="radar-release">
      <p className="text-xs text-muted flex flex-wrap items-center gap-2">
        {release.brand === undefined ? null : <BrandChip brand={release.brand} onBrand={onBrand} />}
        <NewsKindBadge kind={release.kind} />
        {/* An undated release carries the day the scan first found it: say so, not "approximate". */}
        <span>
          {release.date_approximate ? `${t('releases.undated')} ` : null}
          <time dateTime={release.release_date}>{formatCalendarDay(release.release_date, i18n.language)}</time>
        </span>
        <span className={release.source_kind === 'official' ? 'badge-accent' : 'badge-muted'}>
          {release.source_kind === 'official' ? t('releases.official') : t('releases.thirdParty')}
        </span>
        <span>{t('releases.mentions', { count: release.mentions })}</span>
        <FoundViaMarker foundVia={release.found_via} />
      </p>
      <h3 className="text-sm font-semibold text-text-strong mt-1 break-words">{release.feature}</h3>
      {release.summary === '' ? null : <p className="text-sm text-text mt-1">{release.summary}</p>}
      <Citations release={release} />
    </li>
  )
}

/** The items of the chosen kind, or a line saying there are none of it. */
function ReleaseList({ releases, kind, onBrand }: Readonly<{ releases: readonly TimelineRelease[]; kind: NewsKindChoice; onBrand?: OnBrand }>) {
  const { t } = useTranslation('radar')
  const kindLabel = useNewsKindLabel()
  if (releases.length === 0 && kind !== 'all') {
    return <p className="text-sm text-muted">{t('releases.kindEmpty', { kind: kindLabel(kind) })}</p>
  }
  return (
    <ol className="space-y-4 border-l border-border pl-4">
      {releases.map((release) => (
        <ReleaseItem key={`${release.brand?.key ?? ''}/${release.release_id}`} release={release} onBrand={onBrand} />
      ))}
    </ol>
  )
}

export default function ReleasesTimeline({ releases, id = 'radar-releases', title, note, onBrand }: Readonly<{
  releases: readonly TimelineRelease[]
  /** The heading's id (two timelines never share one). */
  id?: string
  /** The heading; "News and releases" when not given. */
  title?: string
  /** A muted line under the list (the combined feed's "Showing the newest 100 of N"). */
  note?: string
  /** Opens a brand from its chip (the combined feed only). */
  onBrand?: OnBrand
}>) {
  const { t } = useTranslation('radar')
  const [kind, setKind] = useState<NewsKindChoice>('all')
  return (
    <section className="card min-w-0" aria-labelledby={id}>
      <SectionTitle id={id} icon={Rocket}>{title ?? t('releases.title')}</SectionTitle>
      {releases.length === 0 ? <p className="text-sm text-muted">{t('releases.empty')}</p> : (
        <>
          <NewsKindFilter value={kind} onChange={setKind} />
          <ReleaseList releases={kind === 'all' ? releases : releases.filter((release) => release.kind === kind)} kind={kind}
            onBrand={onBrand} />
        </>
      )}
      {note === undefined ? null : <p className="text-xs text-muted mt-3">{note}</p>}
    </section>
  )
}
