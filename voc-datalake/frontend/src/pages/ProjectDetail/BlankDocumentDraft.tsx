/**
 * @fileoverview A blank PRD or PR/FAQ being named, before anything is filed (a section's New → Blank;
 * useBlankDocument). It stands where the document's page will open: the predefined name ("Untitled PRD") in the
 * page's large title, selected, so typing replaces it. Enter or "Start writing" files it (the hand-written route,
 * from the server's outline) and its page opens with the caret in the text; Escape or Cancel files nothing and puts
 * focus back where it was (the section's New).
 *
 * A PRD / PR/FAQ's name is its series: every version keeps it, so it cannot change once filed (the pane says so).
 * An empty name, or the name of a series of that type the project already has (it would only add a version to
 * it), is refused here with the reason, before any request.
 *
 * @module pages/ProjectDetail/BlankDocumentDraft
 */
import { Loader2, PenLine } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DocumentTypeBadge } from '../../components/DocumentTypeBadge/DocumentTypeBadge'
import { PAGE_SHEET_CLASS, TITLE_INPUT_CLASS } from '../../components/DocumentCanvas/page/pageStyles'
import { isTitleTaken } from './blankTitles'
import type { KeyboardEvent, SyntheticEvent } from 'react'
import type { BlankDocumentControls, PendingBlank } from './useBlankDocument'
import type { ProjectDocument } from '../../api/types'

interface BlankDocumentDraftProps {
  readonly pending: PendingBlank
  readonly documents: readonly ProjectDocument[]
  readonly blank: Pick<BlankDocumentControls, 'createPending' | 'cancelPending' | 'creatingPending' | 'pendingFailed'>
}

type Refusal = 'required' | 'taken' | null

/** Why `name` cannot be filed as a new document of `pending`'s type, or null. */
function refusalOf(name: string, pending: PendingBlank, documents: readonly ProjectDocument[]): Refusal {
  if (name === '') return 'required'
  return isTitleTaken(pending.type, name, documents) ? 'taken' : null
}

export default function BlankDocumentDraft({ pending, documents, blank }: BlankDocumentDraftProps) {
  const { t } = useTranslation('projectDetail')
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const [title, setTitle] = useState(pending.title)
  const [refusal, setRefusal] = useState<Refusal>(null)
  // Where focus was when the pane opened (the section's New): Cancel puts it back.
  const [returnTo] = useState(() => globalThis.document.activeElement)
  const input = useRef<HTMLInputElement>(null)
  const type = pending.type === 'prd' ? t('documents.sections.prd') : t('documents.sections.prfaq')
  useEffect(() => { input.current?.select() }, [])

  const submit = (event?: SyntheticEvent) => {
    event?.preventDefault()
    const name = title.trim()
    const refused = refusalOf(name, pending, documents)
    setRefusal(refused)
    if (refused !== null) {
      input.current?.focus()
      return
    }
    blank.createPending(name)
  }
  const cancel = () => {
    blank.cancelPending()
    if (returnTo instanceof HTMLElement) returnTo.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  const message = (() => {
    if (refusal === 'required') return t('documents.blank.nameRequired')
    if (refusal === 'taken') return t('documents.blank.nameTaken', { title: title.trim(), type })
    return blank.pendingFailed ? t('documents.blank.createFailed', { type }) : null
  })()

  return (
    <section data-testid="document-detail-pane" aria-label={t('documents.blank.draftLabel', { type })}
      className="bg-card rounded-xl border min-w-0 lg:min-h-[500px]">
      <form className={PAGE_SHEET_CLASS} onSubmit={submit} noValidate>
        <label htmlFor={inputId} className="sr-only">{t('canvas.page.titleLabel')}</label>
        <input ref={input} id={inputId} type="text" value={title} autoFocus autoComplete="off" spellCheck
          readOnly={blank.creatingPending} aria-invalid={refusal === null ? undefined : true}
          aria-describedby={message === null ? hintId : `${errorId} ${hintId}`}
          onChange={(event) => { setTitle(event.target.value); setRefusal(null) }} onKeyDown={onKeyDown}
          className={TITLE_INPUT_CLASS} />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
          <DocumentTypeBadge type={pending.type} />
          <span className="badge badge-muted"><PenLine size={12} aria-hidden />{t('documents.blank.handWritten')}</span>
        </div>
        <p id={hintId} className="mt-4 max-w-[70ch] text-sm text-muted">{t('documents.blank.nameHint', { type })}</p>
        {message === null ? null : <p id={errorId} role="alert" className="mt-2 text-sm text-danger">{message}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary btn-sm" disabled={blank.creatingPending}>
            {blank.creatingPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <PenLine size={14} aria-hidden />}
            {blank.creatingPending ? t('documents.blank.creating') : t('documents.blank.startWriting')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={blank.creatingPending} onClick={cancel}>
            {t('documents.blank.cancel')}
          </button>
        </div>
        <div aria-hidden className="mt-10 min-h-[12rem] rounded-lg border border-dashed border-border p-6 text-sm text-muted">
          {t('documents.blank.outlineNote', { type })}
        </div>
      </form>
    </section>
  )
}
