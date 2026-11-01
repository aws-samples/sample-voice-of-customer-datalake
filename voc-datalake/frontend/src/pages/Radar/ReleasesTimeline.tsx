/**
 * @fileoverview News and releases as compact rows (ReleaseRow), newest first, above them a kind
 * filter (client-side; NewsKind). The newest {@link COLLAPSED_RELEASES} show first, then "Show all N";
 * expanded, the list is grouped by month under month headings.
 * One brand's releases on the brand view; on "All brands" the combined feed, where each release
 * also names its brand (a chip that opens that brand).
 * @module pages/Radar/ReleasesTimeline
 */
import { Rocket } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NewsKindFilter } from './NewsKind'
import { useNewsKindLabel } from './newsKindLabel'
import ReleaseRow from './ReleaseRow'
import SectionTitle from './SectionTitle'
import { groupByMonth } from './radarGroups'
import { newestFirst } from './radarReads'
import { formatCalendarMonth } from '../../utils/dateUtils'
import type { NewsKindChoice } from './NewsKind'
import type { OnBrand, TimelineRelease } from './ReleaseRow'

/** How many rows show before "Show all N". */
const COLLAPSED_RELEASES = 5

const rowKey = (release: TimelineRelease) => `${release.brand?.key ?? ''}/${release.release_id}`

function Rows({ releases, onBrand }: Readonly<{ releases: readonly TimelineRelease[]; onBrand?: OnBrand }>) {
  return (
    <ol className="min-w-0">
      {releases.map((release) => <ReleaseRow key={rowKey(release)} release={release} onBrand={onBrand} />)}
    </ol>
  )
}

function ByMonth({ releases, onBrand }: Readonly<{ releases: readonly TimelineRelease[]; onBrand?: OnBrand }>) {
  const { i18n } = useTranslation('radar')
  return (
    <div className="space-y-3">
      {groupByMonth(releases).map(({ month, items }) => (
        <div key={month} className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-[.04em] text-text mb-1" data-testid="release-month">
            {formatCalendarMonth(month, i18n.language)}
          </h3>
          <Rows releases={items} onBrand={onBrand} />
        </div>
      ))}
    </div>
  )
}

/** The items of the chosen kind (newest 5, or all by month), or a line saying there are none of it. */
function ReleaseList({ releases, kind, onBrand }: Readonly<{ releases: readonly TimelineRelease[]; kind: NewsKindChoice; onBrand?: OnBrand }>) {
  const { t } = useTranslation('radar')
  const kindLabel = useNewsKindLabel()
  const [expanded, setExpanded] = useState(false)
  // Empty only for one kind: the section itself says when there is no news at all.
  if (releases.length === 0) return kind === 'all' ? null : <p className="text-sm text-muted">{t('releases.kindEmpty', { kind: kindLabel(kind) })}</p>
  const more = releases.length > COLLAPSED_RELEASES
  return (
    <>
      {expanded ? <ByMonth releases={releases} onBrand={onBrand} /> : <Rows releases={releases.slice(0, COLLAPSED_RELEASES)} onBrand={onBrand} />}
      {more ? (
        <button type="button" className="btn btn-secondary btn-sm mt-2" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t('releases.showFewer') : t('releases.showAll', { count: releases.length })}
        </button>
      ) : null}
    </>
  )
}

export default function ReleasesTimeline({ releases, id = 'radar-releases', title, note, onBrand }: Readonly<{
  releases: readonly TimelineRelease[]
  /** The heading's id (two timelines never share one); the summary strip links to the default one. */
  id?: string
  /** The heading; "News and releases" when not given. */
  title?: string
  /** A line under the list (the combined feed's "Showing the newest 100 of N"). */
  note?: string
  /** Opens a brand from its chip (the combined feed only). */
  onBrand?: OnBrand
}>) {
  const { t } = useTranslation('radar')
  const [kind, setKind] = useState<NewsKindChoice>('all')
  const shown = newestFirst(kind === 'all' ? releases : releases.filter((release) => release.kind === kind))
  return (
    <section className="card min-w-0 scroll-mt-4" aria-labelledby={id}>
      <SectionTitle id={id} icon={Rocket}>{title ?? t('releases.title')}</SectionTitle>
      {releases.length === 0 ? <p className="text-sm text-muted">{t('releases.empty')}</p> : (
        <>
          <NewsKindFilter value={kind} onChange={setKind} />
          {/* A new kind starts collapsed again (its own list). */}
          <ReleaseList key={kind} releases={shown} kind={kind} onBrand={onBrand} />
        </>
      )}
      {note === undefined ? null : <p className="text-xs text-text mt-3">{note}</p>}
    </section>
  )
}
