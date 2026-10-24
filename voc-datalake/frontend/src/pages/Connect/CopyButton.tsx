/**
 * @fileoverview The Connect page's copy button: one clipboard state per page
 * section, keyed so only the button that copied shows "Copied".
 *
 * @module pages/Connect/CopyButton
 */
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function CopyButton({ text, copyKey, copiedKey, onCopy }: Readonly<{
  text: string; copyKey: string; copiedKey: string | null; onCopy: (text: string, key: string) => void
}>) {
  const { t } = useTranslation('common')
  const copied = copiedKey === copyKey
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCopy(text, copyKey)}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? t('connect.copied') : t('connect.copy')}
    </button>
  )
}
