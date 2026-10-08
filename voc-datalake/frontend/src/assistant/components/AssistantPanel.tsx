/**
 * @fileoverview The assistant panel, in four presentations:
 *   - `bubble`     ~400×600 anchored bottom-right
 *   - `expanded`   ~720px wide × 85vh, bottom-right
 *   - `fullscreen` `fixed inset-0`, focus-trapped; Esc returns to expanded
 *   - `page`       inline, filling the `/chat` route
 *
 * The wide presentations (`page`, `fullscreen`) show a permanent conversation
 * sidebar from `lg` up, so the user can run several conversations at once and
 * switch between them; the others open the same list as a drawer.
 *
 * @module assistant/components/AssistantPanel
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Plus } from 'lucide-react'
import { useAssistant } from '../runtime/useAssistant'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { sessionTitle } from '../sessions/serialize'
import ApprovalList from './ApprovalList'
import Composer from './Composer'
import EmptyState from './EmptyState'
import MessageList from './MessageList'
import PanelHeader from './PanelHeader'
import SessionList from './SessionList'
import SessionsDrawer from './SessionsDrawer'
import { downloadMarkdown, threadToMarkdown } from './exportMarkdown'
import { useFocusTrap } from './useFocusTrap'
import { FOLLOW_TIMEOUT_CODE } from '../runtime/followServerRun'
import type { TFunction } from 'i18next'
import type { ThreadState } from '../thread/types'
import type { PanelVariant } from './PanelHeader'
import type { PanelMode } from '../store/assistantStore'
import type { PanelAnchor } from '../bubble/geometry'

// Below `sm` (640px) a 400/720px card beside a 390px page is just a smaller
// screen: the floating modes become a sheet that fills the viewport above the
// launcher (KiroCrew narrow-viewport rule), keeping the desktop sizes from `sm` up.
// From `sm` up the card sits beside the (draggable) launcher: `anchor` sets the
// `--ap-*` variables (bubble/geometry panelAnchor); the fallbacks are the
// default bottom-right placement.
const NARROW_SHEET = 'max-sm:inset-x-2 max-sm:top-2 max-sm:bottom-20 max-sm:h-auto max-sm:max-h-none max-sm:w-auto'
const ANCHORED = 'sm:left-[var(--ap-left,auto)] sm:right-[var(--ap-right,1rem)] sm:top-[var(--ap-top,auto)] sm:bottom-[var(--ap-bottom,5rem)] sm:max-w-[min(var(--ap-max-w,100vw),calc(100vw-2rem))]'
const FLOATING_CARD = `fixed z-50 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card shadow-2xl animate-scale-in ${ANCHORED} ${NARROW_SHEET}`
const MODE_CLASSES: Record<PanelMode, string> = {
  bubble: `${FLOATING_CARD} h-[600px] sm:max-h-[min(var(--ap-max-h,100vh),calc(100vh-6rem))] w-[400px]`,
  expanded: `${FLOATING_CARD} h-[85vh] sm:max-h-[var(--ap-max-h,85vh)] w-[720px]`,
  fullscreen: 'fixed inset-0 z-[60] bg-bg',
}
/** Reading width for the conversation when the panel is wide (page or full screen). */
const WIDE_COLUMN = 'mx-auto w-full max-w-3xl'

/** Why the composer is closed, if it is: an approval to answer, or an answer the server is still writing. */
function blockedReasonFor(status: ThreadState['status'], t: TFunction<'assistant'>): string | null {
  if (status === 'awaiting_approval') return t('composer.awaitingApproval')
  if (status === 'generating') return t('composer.stillGenerating')
  return null
}

function useErrorText(code: string | undefined, message: string | undefined): string | null {
  const { t } = useTranslation('assistant')
  if (message === undefined) return null
  if (code === 'STREAM_CLOSED') return t('errors.streamClosed')
  if (code === FOLLOW_TIMEOUT_CODE) return t('errors.followTimeout')
  return t('errors.generic', { message })
}

/**
 * The permanent conversation list on wide panels (`/chat`, full screen) from
 * `lg` up; below that the header's history button opens the drawer instead.
 */
function SessionsSidebar({ onNewChat, onPick }: Readonly<{ onNewChat: () => void; onPick: (id: string) => void }>) {
  const { t } = useTranslation('assistant')
  return (
    <nav className="hidden w-64 flex-shrink-0 flex-col border-r border-border bg-bg-elevated lg:flex" aria-label={t('sessions.sidebar')}>
      {/* The sidebar's own title, so its group headings sit one level below it
          rather than jumping from the page's h1 to an h4 (E2E F9). */}
      <h2 className="sr-only">{t('sessions.sidebar')}</h2>
      <div className="flex-shrink-0 p-2">
        <button type="button" onClick={onNewChat} className="btn btn-secondary w-full justify-center">
          <Plus size={14} aria-hidden />
          {t('sessions.newConversation')}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <SessionList onPick={onPick} groupHeadingLevel={3} />
      </div>
    </nav>
  )
}

/** After a reload the threads are gone from memory; bring back the last one in view, once. */
function useRestoreLastSession(open: (id: string) => Promise<boolean>): void {
  const activeThreadId = useAssistantUiStore((s) => s.activeThreadId)
  const restoreTried = useRef(false)
  useEffect(() => {
    if (restoreTried.current) return
    restoreTried.current = true
    const { thread: current } = useThreadStore.getState()
    if (activeThreadId !== null && current.messages.length === 0 && activeThreadId !== current.threadId) {
      void open(activeThreadId).catch(() => undefined)
    }
  }, [activeThreadId, open])
}

/** The conversation in view: messages, approval cards, error, composer. */
function ConversationPane({ column, draft, onDraft }: Readonly<{
  column: string | undefined
  draft: string | undefined
  onDraft: (text: string) => void
}>) {
  const { t } = useTranslation('assistant')
  const { thread, page, send, stop, resolve, webSearchAvailable } = useAssistant()
  const errorText = useErrorText(thread.error?.code, thread.error?.message)
  const blockedReason = blockedReasonFor(thread.status, t)
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="relative flex-1 overflow-y-auto px-3 py-3">
        <div className={column}>
          {thread.messages.length === 0 ? <EmptyState kind={page.kind} onPick={onDraft} /> : <MessageList thread={thread} page={page} />}
          <div className="mt-3">
            <ApprovalList thread={thread} page={page} onResolve={resolve} />
          </div>
          {errorText !== null && <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger">{errorText}</p>}
        </div>
      </div>
      <Composer
        streaming={thread.status === 'streaming'}
        blockedReason={blockedReason}
        webSearchAvailable={webSearchAvailable}
        onSend={(content) => {
          void send(content)
        }}
        onStop={stop}
        draft={draft}
        innerClassName={column}
      />
    </div>
  )
}

export default function AssistantPanel({ variant, anchor, onResetPosition }: Readonly<{
  variant: PanelVariant
  /** Floating only: where the card sits beside the launcher. */
  anchor?: PanelAnchor
  /** Floating only, when the launcher was moved: put it back in its corner. */
  onResetPosition?: () => void
}>) {
  const { t } = useTranslation('assistant')
  const rootRef = useRef<HTMLDivElement>(null)
  const { thread, page, open, newThread } = useAssistant()
  const mode = useAssistantUiStore((s) => s.mode)
  const setMode = useAssistantUiStore((s) => s.setMode)
  const setOpen = useAssistantUiStore((s) => s.setOpen)
  const [showSessions, setShowSessions] = useState(false)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const fullscreen = variant === 'floating' && mode === 'fullscreen'
  const wide = fullscreen || variant === 'page'
  useFocusTrap(rootRef, fullscreen)
  useRestoreLastSession(open)
  // The floating panel is a non-modal dialog: opening it puts the caret in the
  // composer, where the user is going to type (design audit D-OVL — focus used
  // to stay on the launcher). The page variant (/chat) leaves focus alone.
  useEffect(() => {
    if (variant !== 'floating') return
    const root = rootRef.current
    if (root !== null && !root.contains(document.activeElement)) root.querySelector<HTMLElement>('textarea')?.focus()
  }, [variant])

  const exportThread = () => {
    const title = sessionTitle(thread.messages) || t('panel.title')
    downloadMarkdown('assistant-conversation.md', threadToMarkdown(title, thread.messages, { user: t('export.user'), assistant: t('export.assistant') }))
  }
  const startNewChat = () => {
    newThread()
    setShowSessions(false)
    setDraft(undefined)
  }
  // An open conversation is switched to (it may still be running); a saved one is loaded.
  const pick = (id: string) => {
    setShowSessions(false)
    setDraft(undefined)
    void open(id)
  }

  return (
    <div
      ref={rootRef}
      role={variant === 'floating' ? 'dialog' : 'region'}
      aria-modal={fullscreen || undefined}
      aria-labelledby="assistant-panel-title"
      style={variant === 'floating' && !fullscreen ? anchor : undefined}
      className={clsx(
        'flex flex-col overflow-hidden text-text motion-safe:transition-all',
        // `relative` only in page mode: in floating modes it would override `fixed`.
        variant === 'page' ? 'relative h-full min-h-[480px] rounded-xl border border-border bg-card shadow-sm' : MODE_CLASSES[mode],
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && fullscreen) {
          e.stopPropagation()
          setMode('expanded')
        }
      }}
    >
      <PanelHeader
        page={page}
        variant={variant}
        mode={mode}
        hasSidebar={wide}
        canExport={thread.messages.length > 0}
        onNewChat={startNewChat}
        onToggleSessions={() => setShowSessions((v) => !v)}
        onExport={exportThread}
        onMode={setMode}
        onClose={() => setOpen(false)}
        onResetPosition={variant === 'floating' ? onResetPosition : undefined}
      />
      <div className="flex min-h-0 flex-1">
        {wide && <SessionsSidebar onNewChat={startNewChat} onPick={pick} />}
        {/* Keyed by thread: switching conversations resets scroll and composer state. */}
        <ConversationPane key={thread.threadId} column={wide ? WIDE_COLUMN : undefined} draft={draft} onDraft={setDraft} />
      </div>
      {showSessions && <SessionsDrawer onClose={() => setShowSessions(false)} onOpen={pick} />}
    </div>
  )
}
