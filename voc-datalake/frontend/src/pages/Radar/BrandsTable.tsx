/**
 * @fileoverview "All brands": every tracked brand in one table over the window — reviews,
 * sentiment in words with the positive / negative share, releases in the window and the latest
 * news (with its kind). Each brand name opens that brand's own view (`?brand=<key>`). On a phone the table
 * scrolls sideways inside its card; no cell is ever cut.
 * @module pages/Radar/BrandsTable
 */
import { Table2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import SectionTitle from './SectionTitle'
import { NewsKindBadge } from './NewsKind'
import { sentimentShare, sentimentWords } from '../../components/SentimentWords/sentimentWords'
import { formatCalendarDay } from '../../utils/dateUtils'
import { formatCount, formatPercent } from '../../utils/numberFormat'
import type { RadarAllBrand } from '../../api/radarSchema'

const TH = 'py-2 pr-3 text-left text-xs font-medium text-muted align-bottom'
const TD = 'py-2 pr-3 align-top break-words'

/** Nothing to show in a cell: a dash on screen, words for a screen reader. */
function None({ label }: Readonly<{ label: string }>) {
  return <><span aria-hidden="true" className="text-muted">—</span><span className="sr-only">{label}</span></>
}

function Sentiment({ brand }: Readonly<{ brand: RadarAllBrand }>) {
  const { t, i18n } = useTranslation('radar')
  if (brand.total === 0) return <None label={t('totals.noReviews')} />
  const positive = sentimentShare(brand.sentiment, 'positive')
  const negative = sentimentShare(brand.sentiment, 'negative')
  return (
    <>
      <span className="block text-text">{sentimentWords(t, brand.avg_sentiment ?? 0)}</span>
      {positive === undefined || negative === undefined ? null : (
        <span className="block text-xs text-muted">
          {t('all.shares', { positive: formatPercent(positive, i18n.language), negative: formatPercent(negative, i18n.language) })}
        </span>
      )}
    </>
  )
}

function LatestRelease({ brand }: Readonly<{ brand: RadarAllBrand }>) {
  const { t, i18n } = useTranslation('radar')
  const release = brand.latest_release
  if (release === null) return <None label={t('all.noRelease')} />
  return (
    <>
      <span className="block"><NewsKindBadge kind={release.kind} /></span>
      <span className="block text-text mt-0.5">{release.feature}</span>
      <time className="block text-xs text-muted" dateTime={release.release_date}>
        {formatCalendarDay(release.release_date, i18n.language, 'short')}
      </time>
    </>
  )
}

function BrandRow({ brand, onBrand }: Readonly<{ brand: RadarAllBrand; onBrand: (key: string) => void }>) {
  const { t, i18n } = useTranslation('radar')
  return (
    <tr className="border-t border-border">
      <th scope="row" className={`${TD} text-left font-medium`}>
        <button type="button" className="link text-left [overflow-wrap:anywhere]"
          aria-label={t('all.openBrand', { brand: brand.label })} onClick={() => onBrand(brand.key)}>
          {brand.label}
        </button>
      </th>
      <td className={`${TD} tabular-nums`}>{formatCount(brand.total, i18n.language)}</td>
      <td className={TD}><Sentiment brand={brand} /></td>
      <td className={`${TD} tabular-nums`}>{formatCount(brand.releases_in_window, i18n.language)}</td>
      <td className={TD}><LatestRelease brand={brand} /></td>
    </tr>
  )
}

export default function BrandsTable({ brands, onBrand }: Readonly<{
  brands: readonly RadarAllBrand[]; onBrand: (key: string) => void
}>) {
  const { t } = useTranslation('radar')
  return (
    <section className="card min-w-0" aria-labelledby="radar-all-brands">
      <SectionTitle id="radar-all-brands" icon={Table2}>{t('all.brandsTitle')}</SectionTitle>
      {brands.length === 0 ? <p className="text-sm text-muted">{t('all.noBrands')}</p> : (
        // Wide enough for every column on a desktop card; on a phone it scrolls inside the card.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <caption className="sr-only">{t('all.brandsCaption')}</caption>
            <thead>
              <tr>
                <th scope="col" className={TH}>{t('all.colBrand')}</th>
                <th scope="col" className={TH}>{t('all.colReviews')}</th>
                <th scope="col" className={TH}>{t('all.colSentiment')}</th>
                <th scope="col" className={TH}>{t('all.colReleases')}</th>
                <th scope="col" className={TH}>{t('all.colLatest')}</th>
              </tr>
            </thead>
            <tbody>
              {brands.map((brand) => <BrandRow key={brand.key} brand={brand} onBrand={onBrand} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
