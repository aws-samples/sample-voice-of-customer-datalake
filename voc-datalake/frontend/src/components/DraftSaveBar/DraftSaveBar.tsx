/**
 * @fileoverview Save / Discard for a settings editor that keeps a local draft,
 * with the reason a save is blocked and the outcome of the last save.
 *
 * @module components/DraftSaveBar
 */
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, Loader2, Save, Undo2 } from 'lucide-react'
import StickyActionBar from '../StickyActionBar/StickyActionBar'

interface DraftSaveBarProps {
  dirty: boolean
  /** Why the draft cannot be saved yet (already translated), or null. */
  blockedReason: string | null
  pending: boolean
  saved: boolean
  error: unknown
  onSave: () => void
  onDiscard: () => void
}

function Outcome({ pending, saved, error }: Readonly<Pick<DraftSaveBarProps, 'pending' | 'saved' | 'error'>>) {
  const { t } = useTranslation('components', { keyPrefix: 'draftSaveBar' })
  if (pending) return <p className="text-sm text-accent-text flex items-center gap-2"><Loader2 size={14} className="animate-spin" />{t('saving')}</p>
  if (error != null) {
    return (
      <p role="alert" className="text-sm text-text flex items-center gap-2 bg-danger-subtle border border-danger/30 rounded-md px-3 py-2">
        <AlertCircle size={14} className="text-danger flex-shrink-0" aria-hidden="true" />
        {t('saveError', { reason: error instanceof Error ? error.message : '' })}
      </p>
    )
  }
  return saved ? <p className="text-sm text-ok flex items-center gap-2"><Check size={14} />{t('saved')}</p> : null
}

export default function DraftSaveBar({ dirty, blockedReason, pending, saved, error, onSave, onDiscard }: Readonly<DraftSaveBarProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'draftSaveBar' })
  return (
    <div className="space-y-2">
      {dirty && blockedReason !== null && (
        <p role="status" className="text-sm text-warn flex items-center gap-2">
          <AlertCircle size={14} aria-hidden="true" /> {blockedReason}
        </p>
      )}
      <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-2 py-2">
        <button type="button" onClick={onSave} disabled={!dirty || blockedReason !== null || pending} className="btn btn-primary">
          <Save size={14} aria-hidden="true" /> {t('save')}
        </button>
        <button type="button" onClick={onDiscard} disabled={!dirty || pending} className="btn btn-ghost">
          <Undo2 size={14} aria-hidden="true" /> {t('discard')}
        </button>
      </StickyActionBar>
      <Outcome pending={pending} saved={saved} error={error} />
    </div>
  )
}
