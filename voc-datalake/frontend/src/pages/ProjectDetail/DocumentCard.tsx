/**
 * @fileoverview One document of the documents list (DocumentList): a card that selects it (its type badge, version or
 * ordinal, last-edit date and title), with its menu (DocumentCardMenu: a right-click, the ContextMenu key or
 * Shift+F10 on the card, or its "⋯") and, for Rename, its title edited in place.
 *
 * Rename turns the title into a field ("Document title"), its text selected. Enter saves and Escape cancels, focus
 * back on the card; leaving the field saves too. The page title's rule (titleEdit): trimmed, an empty name refused
 * (Enter keeps the field and says why; leaving it puts the name back), the same name saves nothing. The new name
 * shows at once while it is saved; a failure puts the old one back and says why under the card (a 409: the document
 * changed meanwhile).
 *
 * @module pages/ProjectDetail/DocumentCard
 */
import clsx from 'clsx'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiErrorStatus, HTTP_CONFLICT } from '../../api/apiErrorStatus'
import { lastEdit } from '../../api/documentSections'
import { isRenamedInPlace } from '../../components/DocumentCanvas/actions/documentKinds'
import { titleEditOf } from '../../components/DocumentCanvas/page/titleEdit'
import { DocumentTypeBadge } from '../../components/DocumentTypeBadge/DocumentTypeBadge'
import { formatDate } from '../../utils/dateUtils'
import { DocumentCardMenuPopup, DocumentCardMoreButton } from './DocumentCardMenu'
import { DocumentOrdinalLabel } from './DocumentLabels'
import { useCardContextMenu } from './useCardContextMenu'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import type { DocumentOrdinal } from '../../api/documentLineage'
import type { ProjectDocument } from '../../api/types'

/** What an editor may do to a card's document (DocumentsTab's useDocumentCardActions). */
export interface DocumentCardActions {
  /** Save `title` as the document's name: resolves once it is saved, rejects on failure. */
  readonly rename: (document: ProjectDocument, title: string) => Promise<void>
  /** Ask to delete it: the page's confirmation, then the delete. */
  readonly remove: (document: ProjectDocument) => void
  /** A delete is on its way. */
  readonly deleting: boolean
}

interface DocumentCardProps {
  readonly document: ProjectDocument
  readonly selected: boolean
  readonly ordinal: DocumentOrdinal | undefined
  readonly onSelect: () => void
  /** An editor's Rename and Delete; absent for a viewer, whose menu has Open only. */
  readonly actions?: DocumentCardActions
}

type RenameFailure = 'conflict' | 'failed'

const CARD_CLASS = 'w-56 xl:w-full text-left p-3 rounded-lg border transition-colors'

/** A rename in progress: the name it is saved as, over the copy of the document it was made on. */
interface PendingName {
  readonly over: ProjectDocument
  readonly title: string
}

/** The card's Rename: the field's state, the name being saved, and the failure said under the card. */
function useCardRename(document: ProjectDocument, actions: DocumentCardActions | undefined, cardRef: RefObject<HTMLButtonElement | null>) {
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState<PendingName | null>(null)
  const [failure, setFailure] = useState<RenameFailure | null>(null)
  const refocus = useRef(false)
  // The list has a newer copy (the renamed version, once refetched): the card shows the document's own name again.
  if (pending !== null && pending.over !== document) setPending(null)
  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    cardRef.current?.focus()
  }, [editing, cardRef])
  const save = (title: string) => {
    if (actions === undefined) return
    setFailure(null)
    setPending({ over: document, title })
    actions.rename(document, title).catch((error: unknown) => {
      setPending(null)
      setFailure(apiErrorStatus(error) === HTTP_CONFLICT ? 'conflict' : 'failed')
    })
  }
  return {
    editing,
    title: pending?.title ?? document.title,
    failure,
    start: () => {
      setFailure(null)
      setEditing(true)
    },
    save,
    /** The field closed; `refocusCard`: by Enter or Escape, so focus goes back to the card. */
    end: (refocusCard: boolean) => {
      refocus.current = refocusCard
      setEditing(false)
    },
  }
}

/** The card's title as a field (Rename). */
function CardTitleField({ title, onSave, onEnd }: Readonly<{
  title: string
  onSave: (title: string) => void
  onEnd: (refocusCard: boolean) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const inputRef = useRef<HTMLInputElement>(null)
  const errorId = useId()
  const [typed, setTyped] = useState(title)
  const [refused, setRefused] = useState(false)
  // Enter or Escape closed it: the blur as the field goes saves nothing a second time.
  const ended = useRef(false)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const end = (save: boolean, refocusCard: boolean) => {
    ended.current = true
    const edit = titleEditOf(typed, title)
    if (save && edit.kind === 'renamed') onSave(edit.title)
    onEnd(refocusCard)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      end(false, true)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (titleEditOf(typed, title).kind === 'empty') setRefused(true)
    else end(true, true)
  }
  return (
    <>
      <Tooltip kind="description" content={t('documents:page.titleHint')}>
        <input ref={inputRef} type="text" value={typed} aria-label={t('documents:page.titleLabel')} autoComplete="off" spellCheck
          aria-invalid={refused ? true : undefined} aria-describedby={refused ? errorId : undefined}
          onChange={(event) => { setTyped(event.target.value); setRefused(false) }}
          onKeyDown={onKeyDown} onBlur={() => { if (!ended.current) end(true, false) }}
          className="input w-full px-2 py-1 text-sm font-medium" />
      </Tooltip>
      {/* Inserted when the name is refused: an alert that appears is read out. */}
      {refused ? <p id={errorId} role="alert" className="mt-1 text-xs text-danger">{t('documents:page.titleRequired')}</p> : null}
    </>
  )
}

/** The badge row: type, version or ordinal, and the date the section sorts on (last edit). */
function CardDetails({ document, ordinal }: Readonly<{ document: ProjectDocument; ordinal: DocumentOrdinal | undefined }>) {
  const { t, i18n } = useTranslation('projectDetail')
  return (
    // Clear of the "⋯" in the corner.
    <div className="flex items-center gap-2 mb-1 pr-6">
      <DocumentTypeBadge type={document.document_type} />
      {/* Canonical managed-document titles already carry their persisted
          backend version. Only unmanaged types use a contextual ordinal. */}
      <DocumentOrdinalLabel ordinal={ordinal} t={t} />
      {/* The date the section sorts on (last edit), so the list reads in the order of its dates. */}
      <span className="text-xs text-muted">{formatDate(lastEdit(document), i18n.language, '', 'short')}</span>
    </div>
  )
}

function RenameFailureNote({ failure }: Readonly<{ failure: RenameFailure | null }>): ReactNode {
  const { t } = useTranslation('projectDetail')
  if (failure === null) return null
  return (
    <p role="alert" className="mt-1 px-1 text-xs text-danger w-56 xl:w-full">
      {failure === 'conflict' ? t('documents.card.renameConflict') : t('documents.card.renameFailed')}
    </p>
  )
}

export default function DocumentCard({ document, selected, ordinal, onSelect, actions }: DocumentCardProps) {
  const { t } = useTranslation('projectDetail')
  const cardRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const menuId = useId()
  const menu = useCardContextMenu()
  const rename = useCardRename(document, actions, cardRef)
  const tone = selected
    ? 'bg-accent-subtle border-accent/40 [&_.text-muted]:text-text'
    : 'bg-card border-border hover:border-border-strong hover:bg-bg-hover'
  return (
    <div className="group relative">
      {rename.editing ? (
        <div className={clsx(CARD_CLASS, tone)}>
          <CardDetails document={document} ordinal={ordinal} />
          <CardTitleField title={rename.title} onSave={rename.save} onEnd={rename.end} />
        </div>
      ) : (
        <button ref={cardRef} type="button" onClick={onSelect} onContextMenu={menu.onContextMenu} onKeyDown={menu.onKeyDown}
          aria-current={selected ? 'true' : undefined} aria-keyshortcuts="Shift+F10"
          className={clsx(CARD_CLASS, tone, 'focus-ring')}>
          <CardDetails document={document} ordinal={ordinal} />
          <p id={titleId} className="font-medium line-clamp-2 text-sm text-text-strong">{rename.title}</p>
        </button>
      )}
      {actions === undefined || rename.editing ? null : (
        <DocumentCardMoreButton buttonRef={menu.buttonRef} open={menu.opening?.fromButton === true} menuId={menuId}
          selected={selected} describedBy={titleId} onClick={menu.onButtonClick} onKeyDown={menu.onButtonKeyDown} />
      )}
      <DocumentCardMenuPopup menu={menu} menuId={menuId} label={t('documents.card.menu', { title: rename.title })} actions={{
        onOpen: onSelect,
        onRename: actions !== undefined && isRenamedInPlace(document) ? rename.start : undefined,
        onDelete: actions === undefined ? undefined : () => actions.remove(document),
        deleting: actions?.deleting === true,
      }} />
      <RenameFailureNote failure={rename.failure} />
    </div>
  )
}
