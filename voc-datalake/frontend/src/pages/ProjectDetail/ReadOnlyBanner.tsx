/**
 * ReadOnlyBanner - tells a caller without edit access why actions will be refused.
 *
 * Its own component so it loads the `projects` namespace itself: a `t(..., { ns })`
 * from the page's translator would not trigger that namespace's HTTP load.
 */
import { Eye } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function ReadOnlyBanner() {
  const { t } = useTranslation('projects')
  return (
    // warn, not info: edits on this page WILL be refused, so it is a caution rather than a note.
    <p role="status" className="flex items-center gap-2 text-[13px] text-warn bg-warn-subtle border border-warn/30 rounded-lg px-3 py-2">
      <Eye size={16} className="flex-shrink-0" aria-hidden="true" />
      {t('readOnlyBanner')}
    </p>
  )
}
