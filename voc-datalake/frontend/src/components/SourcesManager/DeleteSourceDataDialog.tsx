/**
 * @fileoverview The type-to-confirm dialog of "Delete all data from this source":
 * Delete is enabled only once the source id is typed exactly. The typed text
 * is sent as `confirm`, so the server checks it again. The caller renders it
 * only while open, so each opening starts with an empty field.
 *
 * @module components/SourcesManager/DeleteSourceDataDialog
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../ConfirmModal/ConfirmModal'

export default function DeleteSourceDataDialog({ source, isPending, onConfirm, onCancel }: Readonly<{
  source: string
  isPending: boolean
  /** Called with what the person typed (equal to `source`). */
  onConfirm: (typed: string) => void
  onCancel: () => void
}>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourceErasure' })
  const inputId = useId()
  const [typed, setTyped] = useState('')
  return (
    <ConfirmModal isOpen variant="danger" title={t('confirmTitle', { source })} message={t('confirmMessage', { source })}
      confirmLabel={t('confirm')} isLoading={isPending} confirmDisabled={typed !== source}
      onConfirm={() => onConfirm(typed)} onCancel={onCancel}>
      <div className="mt-3 space-y-1">
        <label htmlFor={inputId} className="block text-sm font-medium text-text">{t('typeLabel', { source })}</label>
        <input id={inputId} className="input w-full font-mono" value={typed} autoComplete="off" spellCheck={false}
          disabled={isPending} onChange={(event) => setTyped(event.target.value)} />
      </div>
    </ConfirmModal>
  )
}
