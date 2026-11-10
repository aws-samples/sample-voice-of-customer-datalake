/**
 * @fileoverview The JSON upload's "these items will be skipped" notice: each invalid
 * item by its 1-based position with a plain reason ("Item 2: text is required").
 * The valid items still import; the server re-validates every item it receives.
 * @module pages/Scrapers/JsonSkippedItems
 */
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { SkipReason, SkippedItem } from './jsonUploadSchema'

const SHOWN = 10

function reasonText(t: TFunction<'scrapers'>, reason: SkipReason): string {
  switch (reason.kind) {
    case 'required': return t('jsonUpload.reasonRequired', { field: reason.field })
    case 'type': return t('jsonUpload.reasonType', { field: reason.field })
    case 'notObject': return t('jsonUpload.reasonNotObject')
    case 'invalid': return t('jsonUpload.reasonInvalid', { field: reason.field, message: reason.message })
  }
}

export default function JsonSkippedItems({ skipped }: Readonly<{ skipped: readonly SkippedItem[] }>) {
  const { t } = useTranslation('scrapers')
  if (skipped.length === 0) return null
  return (
    <div role="status" className="p-3 bg-warn-subtle border border-warn/30 rounded-lg text-sm text-warn">
      <p className="font-medium flex items-center gap-1.5">
        <AlertTriangle size={16} className="flex-shrink-0" aria-hidden="true" />
        {t('jsonUpload.skippedTitle', { count: skipped.length })}
      </p>
      <ul className="mt-2 space-y-0.5 list-disc list-inside">
        {skipped.slice(0, SHOWN).map((item) => (
          <li key={item.position}>
            {t('jsonUpload.skippedItem', {
              position: item.position,
              reasons: item.reasons.map((r) => reasonText(t, r)).join('; '),
            })}
          </li>
        ))}
      </ul>
      {skipped.length > SHOWN && <p className="mt-1 text-xs">{t('jsonUpload.moreItems', { count: skipped.length - SHOWN })}</p>}
    </div>
  )
}
