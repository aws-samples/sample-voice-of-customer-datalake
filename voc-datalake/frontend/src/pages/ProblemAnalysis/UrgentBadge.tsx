/**
 * @fileoverview "3 urgent": the warn badge shared by every level of the Problem
 * Analysis tree — a count with its unit, never a bare number.
 * @module pages/ProblemAnalysis/UrgentBadge
 */
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function UrgentBadge({ count }: Readonly<{ count: number }>) {
  const { t } = useTranslation('problemAnalysis')
  if (count <= 0) return null
  return (
    <span className="badge badge-warn flex-shrink-0">
      <AlertTriangle size={12} aria-hidden="true" />
      {t('tree.urgentCount', { count })}
    </span>
  )
}
