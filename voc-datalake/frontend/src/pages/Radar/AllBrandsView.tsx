/**
 * @fileoverview The Radar page's "All brands" view (`?brand=all`, GET /radar/all): every tracked
 * brand side by side, then their releases and news in one feed, newest first, each naming its
 * brand. Picking a brand (its name in the table, or its chip in the feed) opens its own view.
 * @module pages/Radar/AllBrandsView
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import BrandsTable from './BrandsTable'
import ReleasesTimeline from './ReleasesTimeline'
import { RadarLoadFailed, RadarLoading } from './RadarQueryState'
import { allBrandsQuery } from './radarQueries'
import type { TFunction } from 'i18next'
import type { RadarAllBrands } from '../../api/radarSchema'

/** "Showing the newest 100 of 240" when the server capped the feed; undefined when it shows everything. */
function cappedNote(all: RadarAllBrands, t: TFunction): string | undefined {
  if (!all.releases_capped) return undefined
  // The locale's grouping comes from the strings' `{{…, number}}` format ("1,234", de "1.234").
  return t('all.capped', { shown: all.releases.length, total: all.releases_total })
}

export default function AllBrandsView({ days, onBrand }: Readonly<{ days: number; onBrand: (key: string) => void }>) {
  const { t } = useTranslation('radar')
  const all = useQuery(allBrandsQuery(days))
  if (all.isLoading) return <RadarLoading />
  if (all.isError || !all.data) return <RadarLoadFailed query={all} />
  return (
    <div className="space-y-4 sm:space-y-6">
      <BrandsTable brands={all.data.brands} onBrand={onBrand} />
      <ReleasesTimeline id="radar-all-releases" title={t('all.newsTitle')} releases={all.data.releases}
        note={cappedNote(all.data, t)} onBrand={onBrand} />
    </div>
  )
}
