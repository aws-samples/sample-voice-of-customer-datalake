/**
 * @fileoverview The brand view's summary strip: three compact tiles that answer "how are they
 * doing against us" before any detail: their positive share against ours over the window, their new
 * releases in it, and the biggest category gap. Each tile with something behind it opens it: the
 * reviews (ReviewsModal, through `onRead`) or the releases section below.
 * @module pages/Radar/RadarSummary
 */
import { Rocket, Scale, Smile } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { percent } from './radarFormat'
import { biggestGap, readOverall, releasesInWindow } from './radarReads'
import { sentimentWords, signedAverage } from '../../components/SentimentWords/sentimentWords'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { RadarReviewFilter } from '../../api/radarApi'
import { RADAR_PAGE_RELEASES_CAP } from '../../api/radarSchema'
import type { RadarCompare, RadarDetail, RadarRelease } from '../../api/radarSchema'

type OnRead = (filter: RadarReviewFilter) => void

/** The id of the releases section a tile scrolls to (ReleasesTimeline's default heading id). */
const RELEASES_SECTION_ID = 'radar-releases'

const TILE = 'card min-w-0 flex flex-col gap-1 p-4 text-left'
const ACTIVE = 'hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

function TileBody({ icon: Icon, label, children }: Readonly<{ icon: LucideIcon; label: string; children: ReactNode }>) {
  return (
    <>
      <span className="text-xs font-medium text-text flex items-center gap-1.5">
        <Icon size={14} className="text-accent shrink-0" aria-hidden="true" />{label}
      </span>
      {children}
    </>
  )
}

/** A tile: a button when it opens reviews, a link when it jumps to a section, else plain. */
function Tile({ icon, label, onOpen, href, children }: Readonly<{
  icon: LucideIcon; label: string; onOpen?: () => void; href?: string; children: ReactNode
}>) {
  const body = <TileBody icon={icon} label={label}>{children}</TileBody>
  if (onOpen !== undefined) return <button type="button" className={`${TILE} ${ACTIVE}`} onClick={onOpen}>{body}</button>
  if (href !== undefined) return <a href={href} className={`${TILE} ${ACTIVE}`}>{body}</a>
  return <div className={TILE}>{body}</div>
}

const Headline = ({ children }: Readonly<{ children: ReactNode }>) => (
  <span className="text-sm font-semibold text-text-strong break-words">{children}</span>
)
const Meta = ({ children }: Readonly<{ children: ReactNode }>) => <span className="text-xs text-text break-words">{children}</span>

/** "62% positive for them, 55% for you", or why they cannot compare yet. */
function SentimentHeadline({ compare }: Readonly<{ compare: RadarCompare }>) {
  const { t, i18n } = useTranslation('radar')
  const reading = readOverall(compare)
  switch (reading.kind) {
    case 'unknown': return <Headline>{t('summary.sentimentUnknown')}</Headline>
    case 'tooFew': return <Headline>{t('summary.sentimentTooFew', { count: reading.theirs.volume })}</Headline>
    case 'noOurs': return (
      <Headline>{t('summary.sentimentNoOurs', { theirs: percent(reading.theirs.positive_share, i18n.language) })}</Headline>
    )
    case 'compare': return (
      <>
        <Headline>{t('summary.sentimentCompare', {
          theirs: percent(reading.theirs.positive_share, i18n.language), ours: percent(reading.ours.positive_share, i18n.language),
        })}</Headline>
        <Meta>{t('summary.sentimentVolumes', {
          theirs: t('summary.theirReviews', { count: reading.theirs.volume }),
          ours: t('summary.ourReviews', { count: reading.ours.volume }),
        })}</Meta>
      </>
    )
  }
}

function SentimentTile({ detail, compare, onRead }: Readonly<{ detail: RadarDetail; compare: RadarCompare; onRead: OnRead }>) {
  const { t, i18n } = useTranslation('radar')
  const average = detail.avg_sentiment ?? 0
  // The locale's decimal mark ("+0,08" in Polish), never a hard-coded "+0.08" (verify10).
  const words = t('totals.sentimentWords', { words: sentimentWords(t, average), value: signedAverage(average, i18n.language) })
  return (
    <Tile icon={Smile} label={t('summary.sentimentLabel')} onOpen={detail.total === 0 ? undefined : () => onRead({})}>
      <SentimentHeadline compare={compare} />
      <Meta>{detail.total === 0 ? t('totals.noReviews') : `${t('totals.reviews', { count: detail.total })} · ${words}`}</Meta>
    </Tile>
  )
}

function ReleasesTile({ releases, days }: Readonly<{ releases: readonly RadarRelease[]; days: number }>) {
  const { t } = useTranslation('radar')
  const recent = releasesInWindow(releases, days)
  const newest = recent.at(0)
  // The page brings at most RADAR_PAGE_RELEASES_CAP releases, newest first: when every one of them is in the
  // window, older ones in the window may exist, so the count is a lower bound and says so.
  const capped = releases.length >= RADAR_PAGE_RELEASES_CAP && recent.length === releases.length
  return (
    <Tile icon={Rocket} label={t('summary.releasesLabel')} href={newest === undefined ? undefined : `#${RELEASES_SECTION_ID}`}>
      <Headline>{t(capped ? 'summary.releasesCountAtLeast' : 'summary.releasesCount', { count: recent.length, days })}</Headline>
      {newest === undefined ? null : <Meta>{t('summary.releasesNewest', { title: newest.feature })}</Meta>}
    </Tile>
  )
}

function GapTile({ compare, onRead }: Readonly<{ compare: RadarCompare; onRead: OnRead }>) {
  const { t } = useTranslation('radar')
  const labels = useDisplayLabels()
  const gap = biggestGap(compare.categories)
  if (gap === null) {
    return <Tile icon={Scale} label={t('summary.gapLabel')}><Headline>{t('summary.gapNone')}</Headline></Tile>
  }
  const category = labels.category(gap.category)
  const text = {
    they: t('summary.gapTheyLead', { category, count: gap.points }),
    we: t('summary.gapYouLead', { category, count: gap.points }),
    even: t('summary.gapEven', { category }),
  }[gap.leader]
  return (
    <Tile icon={Scale} label={t('summary.gapLabel')} onOpen={() => onRead({ category: gap.category })}>
      <Headline>{text}</Headline>
      <Meta>{t('summary.gapRead', { category })}</Meta>
    </Tile>
  )
}

export default function RadarSummary({ detail, compare, releases, days, onRead }: Readonly<{
  detail: RadarDetail; compare: RadarCompare; releases: readonly RadarRelease[]; days: number; onRead: OnRead
}>) {
  const { t } = useTranslation('radar')
  return (
    <section aria-label={t('summary.title')} className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))]">
      <SentimentTile detail={detail} compare={compare} onRead={onRead} />
      <ReleasesTile releases={releases} days={days} />
      <GapTile compare={compare} onRead={onRead} />
    </section>
  )
}
