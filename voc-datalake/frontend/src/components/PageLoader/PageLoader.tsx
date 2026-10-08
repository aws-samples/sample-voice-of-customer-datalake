/**
 * @fileoverview Loading fallback component for lazy-loaded pages.
 *
 * Announced politely (`role="status"`) with a visually hidden label: a bare
 * spinner told screen-reader users nothing while a page chunk downloaded.
 */
import { useTranslation } from 'react-i18next'

export default function PageLoader() {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center justify-center h-64" role="status" aria-live="polite">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" aria-hidden="true"></div>
      <span className="sr-only">{t('pageLoader.loading')}</span>
    </div>
  )
}
