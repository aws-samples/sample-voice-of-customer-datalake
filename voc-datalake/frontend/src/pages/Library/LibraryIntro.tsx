/**
 * @fileoverview What the Library is for, said once above the list: its items are reference documents, never
 * feedback (nothing in them reaches a metric, a sentiment or a category); `#short-name` in the assistant puts one
 * into a chat; and feedback itself is imported from a CSV or JSON file under Data sources.
 *
 * @module pages/Library/LibraryIntro
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Hash, Info } from 'lucide-react'

/** Where a CSV or JSON file of feedback is imported (the Data sources page's upload actions). */
const FEEDBACK_IMPORT_PATH = '/scrapers'

export default function LibraryIntro() {
  const { t } = useTranslation('library')
  return (
    <section aria-label={t('intro.label')} className="card p-4">
      <ul className="grid grid-cols-1 gap-3 text-sm text-muted md:grid-cols-2">
        <li className="flex min-w-0 items-start gap-2">
          <Info size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
          <span className="min-w-0">
            {t('intro.notFeedback')}{' '}
            <Link to={FEEDBACK_IMPORT_PATH} className="link font-medium">
              {t('intro.importLink')}
            </Link>
          </span>
        </li>
        <li className="flex min-w-0 items-start gap-2">
          <Hash size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
          <span className="min-w-0">{t('intro.mention')}</span>
        </li>
      </ul>
    </section>
  )
}
