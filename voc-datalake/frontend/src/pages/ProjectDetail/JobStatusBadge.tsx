/**
 * JobStatusBadge - Displays job status with appropriate styling
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'

type JobStatus = 'running' | 'pending' | 'completed' | 'failed'

interface JobStatusBadgeProps {
  readonly status: JobStatus
  readonly isStale: boolean
}

export default function JobStatusBadge({
  status, isStale,
}: JobStatusBadgeProps) {
  const { t } = useTranslation('projectDetail')

  const getStatusStyle = (): string => {
    if (isStale) return 'bg-amber-100 text-amber-700'
    switch (status) {
      case 'running': return 'bg-blue-100 text-blue-700'
      case 'pending': return 'bg-yellow-100 text-yellow-700'
      case 'completed': return 'bg-green-100 text-green-700'
      case 'failed': return 'bg-red-100 text-red-700'
      default: return 'bg-gray-100 text-gray-700'
    }
  }

  const label = isStale ? t('jobs.status.mayHaveFailed') : t(`jobs.status.${status}`)

  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded', getStatusStyle())}>
      {label}
    </span>
  )
}
