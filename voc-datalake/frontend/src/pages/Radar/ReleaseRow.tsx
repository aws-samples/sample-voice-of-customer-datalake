/**
 * @fileoverview One news item as a compact row: kind icon, title, date (an undated item reads
 * "first found <date>", muted), the site of its first citation (an official one badged) and, on the
 * combined feed, its brand. The title is a disclosure (`aria-expanded`) that opens the summary and
 * every citation. Web search results must keep their sources (AgentCore acceptable use), so each
 * page is linked once, over https (`uniqueCitations`); a citation without a title shows its host
 * and path (the backend blanks the titles of index and listing pages).
 * @module pages/Radar/ReleaseRow
 */
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FoundViaMarker, NewsKindIcon } from './NewsKind'
import { citationLabel, hostOf, uniqueCitations } from './radarFormat'
import { formatCalendarDay } from '../../utils/dateUtils'
import { httpHref } from '../../utils/httpHref'
import type { RadarBrandRef, RadarRelease } from '../../api/radarSchema'

/** A release, with the brand it is about when the feed mixes brands. */
export type TimelineRelease = RadarRelease & { readonly brand?: RadarBrandRef }
export type OnBrand = (key: string) => void

/** The release's citations that are web links (anything else is dropped, FE-7), each page once. */
function webCitations(release: RadarRelease) {
  return uniqueCitations(release.urls, release.titles)
    .flatMap(({ url, title }) => { const href = httpHref(url); return href === undefined ? [] : [{ url, href, title }] })
}

function Citations({ release }: Readonly<{ release: RadarRelease }>) {
  const { t } = useTranslation('radar')
  return (
    <ul className="flex flex-col gap-1 mt-1" aria-label={t('releases.sources')}>
      {webCitations(release).map(({ url, href, title }) => (
        // A citation label is often a URL path: it may break anywhere so it never pushes the page wider (390 px / 200 %).
        <li key={url} className="min-w-0 max-w-full">
          <a href={href} target="_blank" rel="noopener noreferrer" className="link text-sm inline-flex max-w-full items-center gap-1">
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
    <button type="button" className={`${BRAND_CHIP} hover:text-accent-text`} data-testid="release-brand"
      aria-label={t('all.openBrand', { brand: brand.label })} onClick={() => onBrand(brand.key)}>
      {brand.label}
    </button>
  )
}

/** "Sep 1, 2026", or "first found Oct 25, 2026" (muted) when the item carries no published date. */
function ReleaseDate({ release }: Readonly<{ release: RadarRelease }>) {
  const { t, i18n } = useTranslation('radar')
  const day = <time dateTime={release.release_date}>{formatCalendarDay(release.release_date, i18n.language)}</time>
  if (!release.date_approximate) return <span className="text-text">{day}</span>
  return <span className="text-muted">{t('releases.firstFound')} {day}</span>
}

/** The site of the first citation, badged when the source is the brand's own. */
function SourceSite({ release }: Readonly<{ release: RadarRelease }>) {
  const { t } = useTranslation('radar')
  const first = webCitations(release).at(0)
  return (
    <>
      {first === undefined ? null : <span className="text-text [overflow-wrap:anywhere]" data-testid="release-site">{hostOf(first.href)}</span>}
      {release.source_kind === 'official' ? <span className="badge badge-accent">{t('releases.official')}</span> : null}
    </>
  )
}

function Details({ release, id, open }: Readonly<{ release: RadarRelease; id: string; open: boolean }>) {
  const { t } = useTranslation('radar')
  return (
    <div id={id} hidden={!open} className="mt-2 pl-6 space-y-1">
      {release.summary === '' ? null : <p className="text-sm text-text break-words">{release.summary}</p>}
      <p className="text-xs text-text flex flex-wrap items-center gap-2">
        {/* The row already badges an official source. */}
        {release.source_kind === 'official' ? null : <span>{t('releases.thirdParty')}</span>}
        <span>{t('releases.mentions', { count: release.mentions })}</span>
        <FoundViaMarker foundVia={release.found_via} />
      </p>
      <Citations release={release} />
    </div>
  )
}

export default function ReleaseRow({ release, onBrand }: Readonly<{ release: TimelineRelease; onBrand?: OnBrand }>) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li data-testid="radar-release" className="border-t border-border py-2 min-w-0">
      <div className="flex items-start gap-2 min-w-0">
        <span className="mt-0.5"><NewsKindIcon kind={release.kind} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-text-strong">
            <button type="button" className="text-left inline-flex items-start gap-1 rounded-sm hover:text-accent-text break-words"
              aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
              <Chevron size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{release.feature}</span>
            </button>
          </h3>
          <p className="text-xs flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5 pl-5">
            {release.brand === undefined ? null : <BrandChip brand={release.brand} onBrand={onBrand} />}
            <ReleaseDate release={release} />
            <SourceSite release={release} />
          </p>
        </div>
      </div>
      <Details release={release} id={detailsId} open={open} />
    </li>
  )
}
