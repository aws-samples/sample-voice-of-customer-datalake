/**
 * @fileoverview The X in the top-right corner of a Home card (the subscribe
 * prompt, an agent-decision card). Its accessible name names the card it closes.
 * The card places it: put the card `relative` and leave room on the right of its title.
 *
 * @module pages/Home/brief/CloseCardButton
 */
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

interface Props {
  /** The card's title, for the accessible name ("Close: <title>"). */
  cardTitle: string
  onClose: () => void
  disabled?: boolean
}

export default function CloseCardButton({ cardTitle, onClose, disabled = false }: Readonly<Props>) {
  const { t } = useTranslation('briefing')
  const label = t('closeCard', { title: cardTitle })
  return (
    <button type="button" className="icon-btn focus-ring absolute right-2 top-2 touch-manipulation"
      aria-label={label} title={label} disabled={disabled} onClick={() => { onClose() }}>
      <X size={16} aria-hidden="true" />
    </button>
  )
}
