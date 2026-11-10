/**
 * @fileoverview The "Legal basis" field every customer-data delete asks for
 * (TENETS.md D5): an erasure (one person, a whole source, a participant) and a
 * source's retention period. The text is stored on the job, its audit row and
 * every tombstone, so the hint says what to write and what never to write
 * (the person's name or email). The server requires it and caps it at
 * `MAX_LEGAL_BASIS_CHARS` (`shared/legal_basis.py`), and refuses one holding
 * personal data; an email or phone number is flagged here as it is typed
 * (`hasContactData`, an approximation: the server stays the authority).
 *
 * @module components/LegalBasisField
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { hasContactData, MAX_LEGAL_BASIS_CHARS } from '../../utils/legalBasis'

export default function LegalBasisField({ value, onChange, disabled = false, hint }: Readonly<{
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** Replaces the erasure hint (a retention period's basis reads differently). */
  hint?: string
}>) {
  const { t } = useTranslation('components', { keyPrefix: 'legalBasis' })
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const personal = hasContactData(value)
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{t('label')}</label>
      <input id={id} type="text" required autoComplete="off" maxLength={MAX_LEGAL_BASIS_CHARS} value={value}
        disabled={disabled} aria-invalid={personal} aria-describedby={personal ? `${errorId} ${hintId}` : hintId}
        onChange={(event) => onChange(event.target.value)} className="input w-full" />
      {personal ? <p id={errorId} role="alert" className="text-xs text-danger mt-1">{t('personalData')}</p> : null}
      <p id={hintId} className="text-xs text-muted mt-1">{hint ?? t('hint')}</p>
    </div>
  )
}
