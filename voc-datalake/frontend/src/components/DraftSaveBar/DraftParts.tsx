/**
 * @fileoverview Small pieces the draft editors share: the load gate in front of
 * an editor, and the Remove button of one row.
 *
 * @module components/DraftSaveBar/DraftParts
 */
import { useTranslation } from 'react-i18next'
import { Loader2, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'

/** A spinner while loading, the error while failed, else the editor. */
export function DraftLoadGate({ isLoading, isError, errorText, children }: Readonly<{
  isLoading: boolean; isError: boolean; errorText: string; children: ReactNode
}>) {
  if (isLoading) {
    return <div className="flex items-center justify-center py-8"><Loader2 className="animate-spin text-muted" size={24} /></div>
  }
  if (isError) return <p role="alert" className="text-sm text-danger">{errorText}</p>
  return <>{children}</>
}

/** "Remove" for one row of a draft list; `label` names what is removed. */
export function RemoveRowButton({ label, onRemove }: Readonly<{ label: string; onRemove: () => void }>) {
  const { t } = useTranslation('components', { keyPrefix: 'draftSaveBar' })
  return (
    <button type="button" onClick={onRemove} className="btn btn-danger btn-sm" aria-label={label}>
      <Trash2 size={14} aria-hidden="true" /> {t('remove')}
    </button>
  )
}
