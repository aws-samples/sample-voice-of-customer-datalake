/**
 * @fileoverview Loads `GET /metrics/release-watch` for one query and renders the rows.
 * Used beside the GitHub release breakdown on the Dashboard (every recent release)
 * and on a launched decision (one dated launch).
 * @module components/ReleaseWatch/ReleaseWatchSection
 */
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { releaseWatchApi, type ReleaseWatchQuery } from '../../api/releaseWatchApi'
import ReleaseWatchList from './ReleaseWatchList'

const releaseWatchKey = (query: ReleaseWatchQuery) => ['release-watch', query] as const

export default function ReleaseWatchSection({ query }: Readonly<{ query: ReleaseWatchQuery }>) {
  const { t } = useTranslation('decisions')
  const { data, isLoading, isError } = useQuery({
    queryKey: releaseWatchKey(query),
    queryFn: () => releaseWatchApi.getReleaseWatch(query),
  })
  if (isLoading) {
    return (
      <p className="text-sm text-muted inline-flex items-center gap-2" role="status">
        <Loader2 size={14} className="animate-spin" aria-hidden />{t('releaseWatch.loading')}
      </p>
    )
  }
  if (isError || data === undefined) return <p className="text-sm text-danger" role="alert">{t('releaseWatch.error')}</p>
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{t('releaseWatch.subtitle', { days: data.windowDays })}</p>
      {data.partial.scannedThrough !== null && (
        <p className="text-xs text-warn">{t('releaseWatch.partial', { date: data.partial.scannedThrough })}</p>
      )}
      <ReleaseWatchList releases={data.releases} />
    </div>
  )
}
