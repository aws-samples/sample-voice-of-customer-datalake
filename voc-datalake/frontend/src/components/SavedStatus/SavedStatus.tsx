/**
 * @fileoverview The one "Saved" of Administration's cards (7.54.00, T6): every card saves itself, and after a save
 * the server accepted it says "Saved" in a polite `role="status"` until the card is edited again (never on a timer,
 * never for a page). Nothing renders before a save or after the next edit, as the app's other status lines.
 *
 * A card keeps `saved` itself: true after its save resolved, false again on its next edit (or `saved && !dirty`).
 *
 * @module components/SavedStatus
 */
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export default function SavedStatus({ saved, label, small = false }: Readonly<{
  saved: boolean
  /** The card's own words for it ("Brands saved."); already translated. Default: "Saved". */
  label?: string
  /** The small text of a compact card (`text-xs`). */
  small?: boolean
}>) {
  const { t } = useTranslation('components')
  if (!saved) return null
  return (
    <p role="status" className={clsx('flex items-center gap-1.5 text-ok', small ? 'text-xs' : 'text-sm')}>
      <Check size={14} aria-hidden="true" />{label ?? t('savedStatus.saved')}
    </p>
  )
}
