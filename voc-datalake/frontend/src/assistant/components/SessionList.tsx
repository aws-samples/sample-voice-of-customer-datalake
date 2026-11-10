/**
 * @fileoverview The conversation list shared by the `/chat` sidebar and the
 * floating panel's sessions drawer.
 *
 * OPEN conversations first (in memory; each may be running, waiting for an
 * approval, or holding a reply the user has not looked at yet), then the saved
 * HISTORY (per user, from DynamoDB) minus whatever is already open, grouped by
 * last activity (Today / This week / Older) with relative dates. A search box
 * filters both by title. Picking an open one switches to it without
 * interrupting any run; picking a saved one loads it. Deleting — open or saved
 * — asks first (a destructive confirm naming the conversation).
 *
 * @module assistant/components/SessionList
 */
import { useEffect, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { deleteSession, listSessions } from '../sessions/sessionsApi'
import { SESSIONS_QUERY_KEY } from '../sessions/queryKeys'
import { groupSessions, matchesTitle } from '../sessions/sessionGroups'
import { closeThread } from '../runtime/runtime'
import { slotOf, useThreadStore } from '../store/assistantStore'
import type { ThreadSlot } from '../store/assistantStore'
import type { SessionSummary } from '../sessions/schema'
import { RenameFailureNotice } from './SessionRename'
import { useSessionRename } from './useSessionRename'
import { DeleteConfirm, HistoryRow, OpenRow } from './SessionRows'
import { editableTitle, sessionTitle } from '../sessions/serialize'
import type { DeleteRequest, RowActions } from './SessionRows'

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

const GROUP_HEADING_CLASS = 'px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted first:pt-1'

function GroupHeading({ level, children }: Readonly<{ level: 3 | 4; children: ReactNode }>) {
  return level === 3
    ? <h3 className={GROUP_HEADING_CLASS}>{children}</h3>
    : <h4 className={GROUP_HEADING_CLASS}>{children}</h4>
}

/** Filter conversations by title, like the search in every chat app's sidebar. */
function SearchBox({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const { t } = useTranslation('assistant')
  const id = useId()
  return (
    <div className="relative mb-1">
      <label htmlFor={id} className="sr-only">{t('sessions.search')}</label>
      <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('sessions.searchPlaceholder')}
        className="input h-8 w-full pl-7 text-[13px]"
      />
    </div>
  )
}

/** The title an open conversation shows: the user's rename, else its first message. */
function openRowTitle(slot: ThreadSlot, customTitle: string | null, fallback: string): string {
  return customTitle ?? (sessionTitle(slot.thread.messages) || fallback)
}

/** "Now" for the relative dates, refreshed every minute so "5 min. ago" does not freeze. */
const NOW_TICK_MS = 60_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

interface OpenEntry {
  slot: ThreadSlot
  title: string
  /** What the rename field opens on (the whole first message, not the cut title). */
  editTitle: string
}

function OpenGroup({ entries, activeId, level, actions }: Readonly<{
  entries: readonly OpenEntry[]
  activeId: string
  level: 3 | 4
  actions: RowActions
}>) {
  const { t } = useTranslation('assistant')
  if (entries.length === 0) return null
  return (
    <>
      <GroupHeading level={level}>{t('sessions.openGroup')}</GroupHeading>
      <ul className="space-y-1" aria-label={t('sessions.openGroup')}>
        {entries.map(({ slot, title, editTitle }) => (
          <OpenRow key={slot.thread.threadId} slot={slot} title={title} editTitle={editTitle} active={slot.thread.threadId === activeId} actions={actions} />
        ))}
      </ul>
    </>
  )
}

/** Saved conversations by last activity: a small label per date group, newest first inside each. */
function HistoryGroups({ sessions, nowMs, actions }: Readonly<{
  sessions: readonly SessionSummary[]
  nowMs: number
  actions: RowActions
}>) {
  const { t } = useTranslation('assistant')
  return (
    <div role="group" aria-label={t('sessions.historyGroup')}>
      {groupSessions(sessions, nowMs).map(({ group, items }) => (
        <div key={group}>
          <p className="px-2 pb-0.5 pt-2 text-[12px] text-muted" aria-hidden>{t(`sessions.when.${group}`)}</p>
          <ul className="space-y-1" aria-label={t(`sessions.when.${group}`)}>
            {items.map((s) => (
              <HistoryRow key={s.id} session={s} nowMs={nowMs} actions={actions} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function HistoryStatus({ isLoading, isError, empty, searching }: Readonly<{
  isLoading: boolean
  isError: boolean
  empty: boolean
  searching: boolean
}>) {
  const { t } = useTranslation('assistant')
  if (isLoading) return <Loader2 size={16} className="mx-auto mt-4 animate-spin text-accent motion-reduce:animate-none" aria-label={t('sessions.loading')} />
  if (isError) return <p className="p-2 text-[12px] text-danger" role="alert">{t('sessions.error')}</p>
  if (!empty) return null
  return <p className="p-2 text-[12px] text-muted">{searching ? t('sessions.noMatch') : t('sessions.empty')}</p>
}

export default function SessionList({ onPick, groupHeadingLevel = 4 }: Readonly<SessionListProps>) {
  const { t } = useTranslation('assistant')
  const open = useOpenSlots()
  const { data, isLoading, isError, remove } = useHistory()
  const { rename, failure } = useSessionRename()
  const [pendingDelete, setPendingDelete] = useState<DeleteRequest | null>(null)
  const [query, setQuery] = useState('')
  const customTitles = new Map((data ?? []).map((s) => [s.id, s.customTitle]))
  const openEntries = open.slots
    .map((slot) => {
      const customTitle = customTitles.get(slot.thread.threadId) ?? null
      const title = openRowTitle(slot, customTitle, t('sessions.newConversation'))
      return { slot, title, editTitle: editableTitle(title, customTitle, slot.thread.messages) }
    })
    .filter((entry) => matchesTitle(entry.title, query))
  const openIds = new Set(open.slots.map((s) => s.thread.threadId))
  const saved = (data ?? []).filter((s) => !openIds.has(s.id))
  const history = saved.filter((s) => matchesTitle(s.title === '' ? t('sessions.untitled') : s.title, query))
  const nowMs = useNow()
  const deleting = remove.isPending
  const actions: RowActions = { onPick, onRename: rename, onDelete: setPendingDelete, deleting }

  return (
    <div className="p-2">
      {(open.slots.length > 0 || saved.length > 0) && <SearchBox value={query} onChange={setQuery} />}
      <RenameFailureNotice failure={failure} />
      <OpenGroup entries={openEntries} activeId={open.activeId} level={groupHeadingLevel} actions={actions} />
      <GroupHeading level={groupHeadingLevel}>{t('sessions.historyGroup')}</GroupHeading>
      <HistoryStatus isLoading={isLoading} isError={isError} empty={data !== undefined && history.length === 0} searching={query.trim() !== ''} />
      <HistoryGroups sessions={history} nowMs={nowMs} actions={actions} />
      <DeleteConfirm request={pendingDelete} deleting={deleting} onCancel={() => setPendingDelete(null)}
        onConfirm={(id) => remove.mutate(id, { onSettled: () => setPendingDelete(null) })} />
    </div>
  )
}
