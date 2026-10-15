/**
 * @fileoverview Compact empty state for the Dashboard (/dashboard) shown when
 * the selected time range has no feedback. The full getting-started walkthrough
 * now lives on the Home page (/), so this only orients the user and points them
 * there instead of duplicating the onboarding cards.
 *
 * Reuses the `dashboard` namespace `onboarding.*` strings (heading, subheading,
 * cta) so it adds no new translation keys.
 *
 * @module pages/Dashboard/DashboardEmptyState
 */

import { ArrowRight, Inbox } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

export default function DashboardEmptyState() {
  const { t } = useTranslation('dashboard')

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-400">
          <Inbox size={24} />
        </div>
        <h2 className="mb-2 text-xl font-bold text-gray-900">{t('onboarding.heading')}</h2>
        <p className="mb-6 text-gray-500">{t('onboarding.subheading')}</p>
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          {t('onboarding.cta')} <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  )
}
