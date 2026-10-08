/**
 * @fileoverview The "Go home" action both error screens offer.
 *
 * @module components/RouteErrorBoundary/GoHomeLink
 */

import clsx from 'clsx'
import { Home } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

interface GoHomeLinkProps {
  /** Primary when it is the only (or main) way out, secondary next to a reload/back button. */
  readonly variant: 'primary' | 'secondary'
}

export default function GoHomeLink({ variant }: GoHomeLinkProps) {
  const { t } = useTranslation('components')
  return (
    <Link to="/" className={clsx('btn gap-2', variant === 'primary' ? 'btn-primary' : 'btn-secondary')}>
      <Home size={16} aria-hidden="true" />
      {t('errorBoundary.goHome')}
    </Link>
  )
}
