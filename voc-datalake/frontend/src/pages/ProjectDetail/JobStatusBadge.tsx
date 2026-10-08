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
    if (isStale) return 'bg-warn-subtle text-warn'
    switch (status) {
      case 'running': return 'bg-info-subtle text-info'
      case 'pending': return 'bg-warn-subtle text-warn'
      case 'completed': return 'bg-ok-subtle text-ok'
      case 'failed': return 'bg-danger-subtle text-danger'
      default: return 'bg-bg-hover text-text'
    }
  }

  const label = isStale ? t('jobs.status.mayHaveFailed') : t(`jobs.status.${status}`)

  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded-sm', getStatusStyle())}>
      {label}
    </span>
  )
}
