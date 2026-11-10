/**
 * @fileoverview "Data quality" on the Data Explorer's processed tab: how useful each source's feedback
 * is (the heuristic usefulness band, docs/data-quality.md) over the selected time range, with the share
 * of reviews stored before the band existed shown as "Not rated". A source producing mostly low-content
 * feedback is the signal that a scraper is misconfigured or a form field is skipped. Below it, each source's
 * profile: star ratings, sentiment and text length (DataQualitySectionProfile.tsx).
 * @module pages/DataExplorer/DataQualitySection
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Gauge } from 'lucide-react'
import { getDateRangeParams } from '../../api/client'
import { dataQualityKey, getDataQuality } from '../../api/dataQualityApi'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { useConfigStore } from '../../store/configStore'
import { failedReads } from '../../utils/failedReads'
import { formatPercent } from '../../utils/numberFormat'
import { useAppSourceLabel } from './useAppSourceLabel'
import { CHART_MAX_SOURCES, QualityChart, QualityTable } from './DataQualityViews'
import DataQualitySectionProfile from './DataQualitySectionProfile'
import { shareOf } from '../../api/dataQualitySchema'
import type { DataQuality } from '../../api/dataQualitySchema'

function QualityBody({ data }: Readonly<{ data: DataQuality }>) {
  const { t, i18n } = useTranslation('dataExplorer')
  const labels = useDisplayLabels()
  const sourceName = useAppSourceLabel(labels.source)
  if (data.sources.length === 0) {
    return <p className="text-sm text-muted">{t('dataQuality.empty')}</p>
  }
  const unratedShare = shareOf(data.overall.unrated, data.overall.total)
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {t('dataQuality.unratedShare', { share: formatPercent(unratedShare, i18n.language) })}
        {data.overall.unrated > 0 && <> {t('dataQuality.backfillHint')}</>}
      </p>
      <QualityChart sources={data.sources} sourceName={sourceName} />
      {data.sources.length > CHART_MAX_SOURCES && (
        <p className="text-xs text-muted">{t('dataQuality.chartTop', { count: CHART_MAX_SOURCES })}</p>
      )}
      <QualityTable sources={data.sources} sourceName={sourceName} overall={data.overall} />
      <DataQualitySectionProfile sources={data.sources} overall={data.overall} sourceName={sourceName} />
      {data.isPartial && <p className="text-xs text-muted">{t('dataQuality.partial')}</p>}
    </div>
  )
}

export default function DataQualitySection() {
  const { t } = useTranslation('dataExplorer')
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const range = getDateRangeParams(timeRange, customDays, dateBasis)
  const query = useQuery({
    queryKey: dataQualityKey(range),
    queryFn: () => getDataQuality(range),
    enabled: !!config.apiEndpoint,
  })
  const failure = failedReads([query])
  return (
    <section className="card space-y-3" aria-labelledby="data-quality-title">
      <div>
        <h2 id="data-quality-title" className="flex items-center gap-2 text-base font-semibold text-text-strong">
          <Gauge size={16} aria-hidden="true" /> {t('dataQuality.title')}
        </h2>
        <p className="text-sm text-muted mt-1">{t('dataQuality.description')}</p>
      </div>
      {failure.loadFailed && <LoadFailed onRetry={failure.retry} retrying={failure.retrying} />}
      {!failure.loadFailed && query.data === undefined && (
        <p className="text-sm text-muted" role="status">{t('dataQuality.loading')}</p>
      )}
      {query.data !== undefined && <QualityBody data={query.data} />}
    </section>
  )
}
