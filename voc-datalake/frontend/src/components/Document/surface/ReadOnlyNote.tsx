/**
 * @fileoverview Why a document is read only here, as visible text (never a disabled input; part 5 N15): an `info`
 * note with at most one way on. An older version's note is the version banner ("Viewing v2 of 4", Back to latest,
 * Restore); the others are one line each (managed by the template, an accepted version, changed only by proposals,
 * edited elsewhere, a viewer).
 *
 * @module components/Document/surface/ReadOnlyNote
 */
import { History, Info, Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReadOnlyReason } from '../types'

/** The older version on screen: its number, the latest's once known, and its two ways on. */
export interface OlderVersionNote {
  readonly number: number
  readonly latest: number | null
  readonly onBack: () => void
  /** Restore (a new version with this one's text); null: not offered (a viewer, the version not read yet). */
  readonly restore: { readonly onRestore: () => void; readonly restoring: boolean } | null
}

const NOTE_CLASS = 'flex flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info-subtle p-3 text-sm text-text'

/** "Viewing v2 of 4 · Read only", Back to latest and (for an editor) Restore. */
function OlderVersionBanner({ note }: Readonly<{ note: OlderVersionNote }>) {
  const { t } = useTranslation('documents')
  const version = t('versions.number', { number: note.number })
  const text = note.latest === null
    ? t('versions.viewingOne', { version })
    : t('versions.viewing', { version, latest: note.latest })
  return (
    <section aria-label={t('versions.bannerLabel')} data-testid="older-version-banner" className={`mb-6 ${NOTE_CLASS}`}>
      <History size={14} className="text-info" aria-hidden="true" />
      <p className="mr-auto min-w-0 break-words">
        <span className="font-medium">{text}</span> · {t('versions.readOnly')}
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={note.onBack}>{t('versions.backToLatest')}</button>
      {note.restore === null ? null : (
        <button type="button" className="btn btn-secondary btn-sm" disabled={note.restore.restoring} onClick={note.restore.onRestore}
          aria-label={t('versions.restoreNamed', { version })}>
          {note.restore.restoring ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
          {t('versions.restore')}
        </button>
      )}
    </section>
  )
}

/** A one-line reason (every reason but an older version, which has its banner). */
export function ReadOnlyNote({ reason, olderVersion }: Readonly<{ reason: ReadOnlyReason; olderVersion: OlderVersionNote | null }>) {
  const { t } = useTranslation('documents')
  if (reason === 'olderVersion' && olderVersion !== null) return <OlderVersionBanner note={olderVersion} />
  return (
    <p role="note" className={NOTE_CLASS} data-read-only={reason}>
      <Info size={14} className="text-info" aria-hidden="true" />
      <span className="min-w-0 break-words">{t(`readOnly.${reason}`)}</span>
    </p>
  )
}
