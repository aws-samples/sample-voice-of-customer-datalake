/**
 * @fileoverview The rows of the conversation list (SessionList): an OPEN
 * conversation (in memory, may be running) and a saved HISTORY one, plus the
 * delete confirm both share.
 *
 * Both rows offer Rename and Delete (Delete asks first and is not offered while
 * the server is still writing the answer — it would save the conversation
 * again). An open row also has Close, which only drops it from memory.
 *
 * The actions sit in ONE "More actions" menu per row (lucide MoreHorizontal),
 * shown on hover, on keyboard focus inside the row, on the row in view and
 * always on touch screens — so the title gets the row's width and wraps to two
 * lines (full title in its tooltip) instead of being cut to ~18 characters
 * behind three icons (wave 4).
 *
 * @module assistant/components/SessionRows
 */
import { useTranslation } from 'react-i18next'
import {
  AlertCircle, Circle, Hand, Loader2, MessageSquare, Pencil, Trash2, X,
} from 'lucide-react'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { closeThread } from '../runtime/runtime'
import type { ThreadSlot } from '../store/assistantStore'
import type { SessionSummary } from '../sessions/schema'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { formatRelativeDate } from '../../utils/dateUtils'
import { TitleEditor } from './SessionRename'
import { useRowRename } from './useSessionRename'
import MoreMenu from './MoreMenu'
import type { MoreMenuItem } from './MoreMenu'
import type { TFunction } from 'i18next'

// Stryker disable next-line StringLiteral: layout-only classes, no behaviour to observe
const ROW_CLASS = 'group flex items-center gap-1 rounded-md transition-colors'
// Stryker disable next-line StringLiteral: hover styling only (jsdom applies no :hover)
const ROW_HOVER_CLASS = 'hover:bg-bg-hover'
// Stryker disable next-line StringLiteral: typography classes only
const TITLE_CLASS = 'line-clamp-2 min-w-0 break-words text-[13px] text-text-strong [overflow-wrap:anywhere]'
/**
 * The row's menu shows on hover, on focus within the row, on the active row and on touch screens
 * (no hover there). Hidden with `hidden`, not opacity, so it gives its width back to the title;
 * Tab from the row's main button reaches it because focusing that button reveals it.
 */
// Stryker disable next-line StringLiteral: visibility classes only (jsdom applies no :hover)
const ACTIONS_CLASS = 'hidden group-hover:block group-focus-within:block [@media(hover:none)]:block'

/** A conversation the user asked to delete (the list confirms first). */
export interface DeleteRequest {
  id: string
  title: string
}

/** What a row can do; the list passes the same set to every row. */
export interface RowActions {
  onPick: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (request: DeleteRequest) => void
  /** A delete is in flight: every Delete button waits. */
  deleting: boolean
}

type SlotState = 'streaming' | 'awaiting' | 'error' | 'unread' | 'idle'

function slotState({ thread, unread }: ThreadSlot): SlotState {
  if (thread.status === 'streaming' || thread.status === 'generating') return 'streaming'
  if (thread.status === 'awaiting_approval') return 'awaiting'
  if (thread.status === 'error') return 'error'
  if (unread) return 'unread'
  // Stryker disable next-line StringLiteral: any non-matching state renders exactly like 'idle'
  return 'idle'
}

function StatusIcon({ state }: Readonly<{ state: SlotState }>) {
  const { t } = useTranslation('assistant')
  switch (state) {
    case 'streaming':
      return <Loader2 size={14} className="flex-shrink-0 animate-spin text-accent-text motion-reduce:animate-none" aria-label={t('sessions.status.streaming')} />
    case 'awaiting':
      return <Hand size={14} className="flex-shrink-0 text-warn" aria-label={t('sessions.status.awaiting')} />
    case 'error':
      return <AlertCircle size={14} className="flex-shrink-0 text-danger" aria-label={t('sessions.status.error')} />
    case 'unread':
      return <Circle size={10} className="mx-0.5 flex-shrink-0 fill-current text-accent-text" aria-label={t('sessions.status.unread')} />
    default:
      return <MessageSquare size={14} className="flex-shrink-0 text-muted" aria-hidden />
  }
}

function RowShell({ active, children }: Readonly<{ active: boolean; children: ReactNode }>) {
  return (
    <li className={clsx(ROW_CLASS, active ? 'nav-active' : ROW_HOVER_CLASS)}>
      {children}
    </li>
  )
}

interface RowMenuOptions {
  title: string
  onRename?: () => void
  onDelete?: () => void
  deleting: boolean
  onClose?: () => void
  closeLabel?: string
}

function rowMenuItems(t: TFunction<'assistant'>, options: RowMenuOptions): MoreMenuItem[] {
  const items: MoreMenuItem[] = []
  if (options.onRename !== undefined) {
    items.push({ key: 'rename', label: t('sessions.renameItem'), icon: <Pencil size={14} />, onSelect: options.onRename })
  }
  if (options.onDelete !== undefined) {
    items.push({ key: 'delete', label: t('sessions.deleteItem'), icon: <Trash2 size={14} />, onSelect: options.onDelete, disabled: options.deleting, danger: true })
  }
  if (options.onClose !== undefined) {
    items.push({ key: 'close', label: options.closeLabel ?? t('sessions.closeItem'), icon: <X size={14} />, onSelect: options.onClose })
  }
  return items
}

function RowMenu({ active, options, triggerRef }: Readonly<{
  active: boolean
  options: RowMenuOptions
  triggerRef: RowRename['buttonRef']
}>) {
  const { t } = useTranslation('assistant')
  return (
    <MoreMenu
      label={t('sessions.more', { title: options.title })}
      items={rowMenuItems(t, options)}
      triggerRef={triggerRef}
      iconSize={14}
      className={clsx('mr-0.5', !active && ACTIONS_CLASS)}
    />
  )
}

type RowRename = ReturnType<typeof useRowRename>

export function OpenRow({ slot, active, title, actions }: Readonly<{
  slot: ThreadSlot
  active: boolean
  title: string
  actions: RowActions
}>) {
  const { t } = useTranslation('assistant')
  const { onPick, onRename, onDelete, deleting } = actions
  const state = slotState(slot)
  const running = state === 'streaming'
  const closeLabel = running ? t('sessions.closeRunningItem') : t('sessions.closeItem')
  const row = useRowRename()
  const id = slot.thread.threadId
  return (
    <RowShell active={active}>
      {row.editing
        ? <TitleEditor initial={title} onSave={(next) => onRename(id, next)} onDone={row.stop} returnFocusTo={row.buttonRef} />
        : (
          <button
            type="button"
            onClick={() => onPick(id)}
            aria-current={active || undefined}
            className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
          >
            <span className="mt-0.5 flex flex-shrink-0"><StatusIcon state={state} /></span>
            <span className={clsx(TITLE_CLASS, state === 'unread' && 'font-semibold')} title={title}>{title}</span>
          </button>
        )}
      {/* Stays mounted while renaming: the editor sends focus back to its button. */}
      <RowMenu
        active={active}
        triggerRef={row.buttonRef}
        options={{
          title,
          deleting,
          onRename: running ? undefined : row.start,
          onDelete: running ? undefined : () => onDelete({ id, title }),
          onClose: () => closeThread(id),
          closeLabel,
        }}
      />
    </RowShell>
  )
}

export function HistoryRow({ session, nowMs, actions }: Readonly<{
  session: SessionSummary
  /** "Now" for the relative dates (refreshed every minute by the list). */
  nowMs: number
  actions: RowActions
}>) {
  const { t, i18n } = useTranslation('assistant')
  const { onPick, onRename, onDelete, deleting } = actions
  const title = session.title === '' ? t('sessions.untitled') : session.title
  const row = useRowRename()
  return (
    <RowShell active={false}>
      {row.editing
        ? <TitleEditor initial={title} onSave={(next) => onRename(session.id, next)} onDone={row.stop} returnFocusTo={row.buttonRef} />
        : (
          <button type="button" onClick={() => onPick(session.id)} className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left">
            <MessageSquare size={14} className="mt-0.5 flex-shrink-0 text-muted" aria-hidden />
            <span className="min-w-0">
              <span className={TITLE_CLASS} title={title}>{title}</span>
              <time dateTime={session.updatedAt} className="block text-[12px] text-muted">
                {formatRelativeDate(session.updatedAt, i18n.language, nowMs)}
              </time>
            </span>
          </button>
        )}
      <RowMenu
        active={false}
        triggerRef={row.buttonRef}
        options={{ title, deleting, onRename: row.start, onDelete: () => onDelete({ id: session.id, title }) }}
      />
    </RowShell>
  )
}

/** The destructive confirm before a saved conversation is deleted for good. */
export function DeleteConfirm({ request, deleting, onConfirm, onCancel }: Readonly<{
  request: DeleteRequest | null
  deleting: boolean
  onConfirm: (id: string) => void
  onCancel: () => void
}>) {
  const { t } = useTranslation('assistant')
  if (request === null) return null
  return (
    <ConfirmModal isOpen variant="danger" title={t('sessions.deleteConfirmTitle', { title: request.title })}
      message={t('sessions.deleteConfirmMessage')} confirmLabel={t('sessions.deleteConfirm')} isLoading={deleting}
      onConfirm={() => onConfirm(request.id)} onCancel={onCancel} />
  )
}
