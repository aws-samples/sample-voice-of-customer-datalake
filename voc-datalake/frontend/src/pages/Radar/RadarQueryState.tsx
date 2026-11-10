/**
 * @fileoverview How every Radar read says it is loading or failed: one muted line while
 * loading, and LoadFailed (an alert with a retry that refetches the read) when it failed.
 * @module pages/Radar/RadarQueryState
 */
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import type { UseQueryResult } from '@tanstack/react-query'

export function RadarLoading() {
  const { t } = useTranslation('radar')
  return <p className="text-sm text-muted">{t('loading')}</p>
}

export function RadarLoadFailed({ query }: Readonly<{ query: Pick<UseQueryResult, 'refetch' | 'isFetching'> }>) {
  const { t } = useTranslation('radar')
  return <LoadFailed message={t('loadFailed')} onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
}
