/**
 * @fileoverview The one "write this field with AI" button: same size, label, loading,
 * disabled and error look wherever a form offers an AI draft of what the person types.
 *
 * The label says what will happen to the fields: "Draft with AI" when they are empty,
 * "Improve with AI" when they hold text (the AI keeps that text's meaning and expands it).
 * A gated button (`disabledReason`) shows the reason as visible text, linked with
 * `aria-describedby`, rather than greying out silently; a failed draft is an announced
 * alert under the button, and the fields are left as they were.
 * @module components/AIDraftButton
 */
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

interface AIDraftButtonProps {
  /** What it writes ("title and description"): read after the label by screen readers, so two
   *  buttons on one form have distinct names. */
  readonly subject: string
  /** The fields it writes hold text: the label becomes "Improve with AI". */
  readonly hasText: boolean
  /** A draft is running: spinner + "Drafting…", and the button waits for it. */
  readonly busy: boolean
  readonly onClick: () => void
  /** The tooltip: what the AI reads (e.g. "Uses this project's feedback"). */
  readonly hint: string
  /** Why it cannot run yet; set = disabled, with this shown under the button. */
  readonly disabledReason?: string | null
  /** The last draft's failure, shown as an alert under the button. */
  readonly error?: string | null
}

/** The ids of whichever notes are showing, for `aria-describedby` (undefined when none). */
function describedBy(notes: ReadonlyArray<readonly [id: string, text: string | null]>): string | undefined {
  const ids = notes.filter(([, text]) => text !== null).map(([id]) => id)
  return ids.length > 0 ? ids.join(' ') : undefined
}

/** Spinner + "Drafting…" while busy, else the AI mark + "Draft with AI" / "Improve with AI". */
function ButtonContent({ busy, hasText, subject }: Readonly<{ busy: boolean; hasText: boolean; subject: string }>) {
  const { t } = useTranslation('components')
  const target = <span className="sr-only"> — {subject}</span>
  if (busy) return <><Loader2 size={14} aria-hidden="true" className="animate-spin" />{t('aiDraftButton.drafting')}{target}</>
  return (
    <>
      <Sparkles size={14} aria-hidden="true" className="text-aim" />
      {hasText ? t('aiDraftButton.improve') : t('aiDraftButton.draft')}{target}
    </>
  )
}

export default function AIDraftButton({
  subject, hasText, busy, onClick, hint, disabledReason = null, error = null,
}: AIDraftButtonProps) {
  const reasonId = useId()
  const errorId = useId()

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => onClick()}
        disabled={busy || disabledReason !== null}
        aria-busy={busy}
        aria-describedby={describedBy([[reasonId, disabledReason], [errorId, error]])}
        title={disabledReason ?? hint}
        className="btn btn-secondary btn-sm"
      >
        <ButtonContent busy={busy} hasText={hasText} subject={subject} />
      </button>
      {disabledReason === null ? null : (
        <p id={reasonId} className="text-xs text-muted text-right">{disabledReason}</p>
      )}
      {error === null ? null : (
        <p id={errorId} role="alert" className="text-xs text-danger flex items-center gap-1.5 text-right">
          <AlertTriangle size={12} aria-hidden="true" className="flex-shrink-0" />{error}
        </p>
      )}
    </div>
  )
}
