/**
 * @fileoverview The conversation list shared by the `/chat` sidebar and the
 * floating panel's sessions drawer.
 *
 * Two groups: OPEN conversations (in memory; each may be running, waiting for
 * an approval, or holding a reply the user has not looked at yet) and the
 * saved HISTORY (per user, from DynamoDB) minus whatever is already open.
 * Picking an open one switches to it without interrupting any run; picking a
 * saved one loads it.
 *
 * @module assistant/components/SessionList
 */
import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle, Circle, Hand, Loader2, MessageSquare, Trash2, X,
} from 'lucide-react'
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { deleteSession, listSessions } from '../sessions/sessionsApi'
import { SESSIONS_QUERY_KEY } from '../sessions/queryKeys'
import { sessionTitle } from '../sessions/serialize'
import { closeThread } from '../runtime/runtime'
import { slotOf, useThreadStore } from '../store/assistantStore'
import type { ThreadSlot } from '../store/assistantStore'
import type { SessionSummary } from '../sessions/schema'

// Stryker disable next-line StringLiteral: layout-only classes, no behaviour to observe
const ROW_CLASS = 'group flex items-center gap-1 rounded-md transition-colors'
// Stryker disable next-line StringLiteral: hover styling only (jsdom applies no :hover)
const ROW_HOVER_CLASS = 'hover:bg-bg-hover'
// Stryker disable next-line StringLiteral: typography/truncation classes only
const TITLE_CLASS = 'block min-w-0 truncate text-[13px] text-text-strong'

interface SessionListProps {
  /** Bring an open conversation, or a saved session, into view. */
  onPick: (id: string) => void
  /**
   * Level of the "Open" / "History" group headings: one below the heading the
   * list sits under, so the outline never skips a level (axe heading-order,
   * E2E F9). The drawer titles itself with an h3, so 4 is the default; the
   * /chat sidebar titles itself with an h2 and passes 3.
   */
  groupHeadingLevel?: 3 | 4
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

function OpenRow({ slot, active, onPick }: Readonly<{ slot: ThreadSlot; active: boolean; onPick: (id: string) => void }>) {
  const { t } = useTranslation('assistant')
  const title = sessionTitle(slot.thread.messages) || t('sessions.newConversation')
  const state = slotState(slot)
  const closeLabel = state === 'streaming' ? t('sessions.closeRunning', { title }) : t('sessions.closeThread', { title })
  return (
    <RowShell active={active}>
      <button
        type="button"
        onClick={() => onPick(slot.thread.threadId)}
        aria-current={active || undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <StatusIcon state={state} />
        <span className={clsx(TITLE_CLASS, state === 'unread' && 'font-semibold')}>{title}</span>
      </button>
      <button
        type="button"
        onClick={() => closeThread(slot.thread.threadId)}
        className="icon-btn"
        aria-label={closeLabel}
        title={closeLabel}
      >
        <X size={14} aria-hidden />
      </button>
    </RowShell>
  )
}

/** Open conversations, newest first; an untouched empty one is not listed. */
function useOpenSlots(): { slots: ThreadSlot[]; activeId: string } {
  const slots = useThreadStore((s) => s.slots)
  const order = useThreadStore((s) => s.order)
  const activeId = useThreadStore((s) => s.activeId)
  const listed = [...order].reverse()
    .map((id) => slotOf(slots, id))
    .filter((slot): slot is ThreadSlot => slot !== undefined && slot.thread.messages.length > 0)
  return { slots: listed, activeId }
}

/** Saved sessions, refetched whenever a conversation is saved. */
function useHistory() {
  const queryClient = useQueryClient()
  const saveTick = useThreadStore((s) => s.saveTick)
  const query = useQuery({ queryKey: SESSIONS_QUERY_KEY, queryFn: listSessions })
  useEffect(() => {
    if (saveTick > 0) void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY })
  }, [saveTick, queryClient])
  const remove = useMutation({
    mutationFn: deleteSession,
    onSuccess: (_result, id) => {
      closeThread(id)
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY })
    },
  })
  return { ...query, remove }
}

function HistoryRow({ session, onPick, onDelete, deleting }: Readonly<{
  session: SessionSummary
  onPick: (id: string) => void
  onDelete: (id: string) => void
  deleting: boolean
}>) {
  const { t } = useTranslation('assistant')
  const deleteLabel = t('sessions.delete', { title: session.title })
  return (
    <RowShell active={false}>
      <button type="button" onClick={() => onPick(session.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
        <MessageSquare size={14} className="flex-shrink-0 text-muted" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate text-[13px] text-text-strong">{session.title === '' ? t('sessions.untitled') : session.title}</span>
          <span className="block font-mono text-[11px] text-muted">{session.updatedAt === '' ? '' : new Date(session.updatedAt).toLocaleString()}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDelete(session.id)}
        disabled={deleting}
        className="icon-btn hover:bg-danger-subtle hover:text-danger"
        aria-label={deleteLabel}
        title={deleteLabel}
      >
        <Trash2 size={14} aria-hidden />
      </button>
    </RowShell>
  )
}

const GROUP_HEADING_CLASS = 'px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted first:pt-1'

function GroupHeading({ level, children }: Readonly<{ level: 3 | 4; children: ReactNode }>) {
  return level === 3
    ? <h3 className={GROUP_HEADING_CLASS}>{children}</h3>
    : <h4 className={GROUP_HEADING_CLASS}>{children}</h4>
}

export default function SessionList({ onPick, groupHeadingLevel = 4 }: Readonly<SessionListProps>) {
  const { t } = useTranslation('assistant')
  const open = useOpenSlots()
  const { data, isLoading, isError, remove } = useHistory()
  const openIds = new Set(open.slots.map((s) => s.thread.threadId))
  const history = (data ?? []).filter((s) => !openIds.has(s.id))

  return (
    <div className="p-2">
      {open.slots.length > 0 && (
        <>
          <GroupHeading level={groupHeadingLevel}>{t('sessions.openGroup')}</GroupHeading>
          <ul className="space-y-1" aria-label={t('sessions.openGroup')}>
            {open.slots.map((slot) => (
              <OpenRow key={slot.thread.threadId} slot={slot} active={slot.thread.threadId === open.activeId} onPick={onPick} />
            ))}
          </ul>
        </>
      )}
      <GroupHeading level={groupHeadingLevel}>{t('sessions.historyGroup')}</GroupHeading>
      {isLoading && <Loader2 size={16} className="mx-auto mt-4 animate-spin text-accent motion-reduce:animate-none" aria-label={t('sessions.loading')} />}
      {isError && <p className="p-2 text-[12px] text-danger" role="alert">{t('sessions.error')}</p>}
      {data !== undefined && history.length === 0 && <p className="p-2 text-[12px] text-muted">{t('sessions.empty')}</p>}
      <ul className="space-y-1" aria-label={t('sessions.historyGroup')}>
        {history.map((s) => (
          <HistoryRow key={s.id} session={s} onPick={onPick} onDelete={(id) => remove.mutate(id)} deleting={remove.isPending} />
        ))}
      </ul>
    </div>
  )
}
