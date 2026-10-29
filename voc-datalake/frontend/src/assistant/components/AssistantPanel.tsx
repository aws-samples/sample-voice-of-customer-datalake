/**
 * @fileoverview The assistant panel, in four presentations:
 *   - `bubble`     ~400×600 anchored bottom-right
 *   - `expanded`   ~720px wide × 85vh, bottom-right
 *   - `fullscreen` `fixed inset-0`, focus-trapped; Esc returns to expanded
 *   (Esc in the bubble or the expanded card closes the panel)
 *   - `page`       inline, filling the `/chat` route
 *
 * The wide presentations (`page`, `fullscreen`) show a permanent conversation
 * sidebar from `lg` up (collapsible to a rail, SessionsSidebar), so the user can
 * run several conversations at once and switch between them; the others open
 * the same list as a drawer.
 *
 * @module assistant/components/AssistantPanel
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useAssistant } from '../runtime/useAssistant'
import { shownMode, useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { sessionTitle } from '../sessions/serialize'
import ApprovalList from './ApprovalList'
import Composer from './Composer'
import EmptyState from './EmptyState'
import MessageList from './MessageList'
import PanelHeader from './PanelHeader'
import SessionsDrawer from './SessionsDrawer'
import SessionsSidebar from './SessionsSidebar'
import { downloadMarkdown, threadToMarkdown } from './exportMarkdown'
import { useFocusTrap } from './useFocusTrap'
import { FOLLOW_TIMEOUT_CODE } from '../runtime/followServerRun'
import type { TFunction } from 'i18next'
import type { ThreadState } from '../thread/types'
import type { PageContext } from '../contract'
import type { PanelVariant } from './PanelHeader'
import type { PanelMode } from '../store/assistantStore'
import type { PanelAnchor } from '../bubble/geometry'
import { usePendingDraft } from '../store/usePendingDraft'

// Below `sm` (640px) a 400/720px card beside a 390px page is just a smaller
// screen: the floating modes become a sheet that fills the whole viewport (the
// industry default for a phone chat sheet; its header X closes it and the
// launcher hides while it is open). The base `max-w-[calc(100vw-2rem)]` cap is
// lifted too — left in place it kept the sheet 1rem short of the right edge,
// which is why it never filled a 390px screen (live 5.14). From `sm` up the
// card sits beside the (draggable) launcher: `anchor` sets the `--ap-*`
// variables (bubble/geometry panelAnchor); the fallbacks are the default
// bottom-right placement.
const NARROW_SHEET = 'max-sm:inset-0 max-sm:h-auto max-sm:w-auto max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none max-sm:border-0'
const ANCHORED = 'sm:left-[var(--ap-left,auto)] sm:right-[var(--ap-right,1rem)] sm:top-[var(--ap-top,auto)] sm:bottom-[var(--ap-bottom,5rem)] sm:max-w-[min(var(--ap-max-w,100vw),calc(100vw-2rem))]'
const FLOATING_CARD = `fixed z-50 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card shadow-2xl animate-scale-in ${ANCHORED} ${NARROW_SHEET}`
const MODE_CLASSES: Record<PanelMode, string> = {
  bubble: `${FLOATING_CARD} h-[600px] sm:max-h-[min(var(--ap-max-h,100vh),calc(100vh-6rem))] w-[400px]`,
  expanded: `${FLOATING_CARD} h-[85vh] sm:max-h-[var(--ap-max-h,85vh)] w-[720px]`,
  fullscreen: 'fixed inset-0 z-[60] bg-bg',
}
interface SuggestedDraft {
  threadId: string
  text: string
}

/**
 * A suggested prompt for ONE conversation (a starter, a brief card's act button): prefilled,
 * never sent by itself, and never carried into another conversation (wave 4).
 */
function useSuggestedDraft(threadId: string): { draft: string | undefined; setDraft: (text: string | undefined) => void } {
  const [suggested, setSuggested] = useState<SuggestedDraft | null>(null)
  const setDraft = (text: string | undefined) => setSuggested(text === undefined ? null : { threadId, text })
  usePendingDraft(setDraft)
  return { draft: suggested?.threadId === threadId ? suggested.text : undefined, setDraft }
}

/** Reading width for the conversation when the panel is wide (page or full screen). */
const WIDE_COLUMN = 'mx-auto w-full max-w-3xl'

/** Why the composer is closed, if it is: an approval to answer, or an answer the server is still writing. */
function blockedReasonFor(status: ThreadState['status'], restoring: boolean, t: TFunction<'assistant'>): string | null {
  if (restoring) return t('composer.restoring')
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
 * Whether an Escape raised at `target` is the panel's own: not inside a dialog
 * layered over it (the delete confirm, the review modal), which closes first
 * through its own handler (ModalShell's top-most rule).
 */
function isOwnLayer(root: HTMLElement | null, target: EventTarget): boolean {
  if (root === null || !(target instanceof Element) || !root.contains(target)) return false
  return target.closest('[role="dialog"]') === root
}

/** Messages, the starters of an empty conversation, or a loading line while the last one comes back. */
function ConversationBody({ thread, page, restoring, onDraft, onRegenerate }: Readonly<{
  thread: ThreadState
  page: PageContext
  restoring: boolean
  onDraft: (text: string) => void
  onRegenerate: () => void
}>) {
  const { t } = useTranslation('assistant')
  if (thread.messages.length > 0) return <MessageList thread={thread} page={page} onRegenerate={onRegenerate} />
  if (restoring) {
    return (
      <p role="status" className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted">
        <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
        {t('composer.restoring')}
      </p>
    )
  }
  return <EmptyState kind={page.kind} onPick={onDraft} />
}

/** The conversation in view: messages, approval cards, error, composer. */
function ConversationPane({ column, draft, onDraft }: Readonly<{
  column: string | undefined
  draft: string | undefined
  onDraft: (text: string) => void
}>) {
  const { t } = useTranslation('assistant')
  const { thread, page, send, stop, resolve, regenerate, webSearchAvailable } = useAssistant()
  const errorText = useErrorText(thread.error?.code, thread.error?.message)
  // The last conversation is still loading after a reload: typing now would start a throwaway one.
  const restoring = useThreadStore((s) => s.restore.status === 'pending')
  const blockedReason = blockedReasonFor(thread.status, restoring, t)
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="relative flex-1 overflow-y-auto px-3 py-3">
        <div className={column}>
          <ConversationBody thread={thread} page={page} restoring={restoring} onDraft={onDraft} onRegenerate={regenerate} />
          <div className="mt-3">
            <ApprovalList thread={thread} page={page} onResolve={resolve} />
          </div>
          {errorText !== null && <p role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger">{errorText}</p>}
        </div>
      </div>
      <Composer
        threadId={thread.threadId}
        streaming={thread.status === 'streaming'}
        blockedReason={blockedReason}
        webSearchAvailable={webSearchAvailable}
        projectId={page.kind === 'project' ? page.projectId : undefined}
        onSend={(content, mentions) => {
          void send(content, mentions)
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
  const mode = useAssistantUiStore(shownMode)
  const setMode = useAssistantUiStore((s) => s.setMode)
  const setOpen = useAssistantUiStore((s) => s.setOpen)
  const [showSessions, setShowSessions] = useState(false)
  const { draft, setDraft } = useSuggestedDraft(thread.threadId)
  const fullscreen = variant === 'floating' && mode === 'fullscreen'
  const wide = fullscreen || variant === 'page'
  // The wide panels' conversation list; its own rail button collapses it (one control, not two).
  const sidebarId = useId()
  // The dialog / region is named by its heading; a per-instance id, never one fixed id for both variants.
  const titleId = useId()
  useFocusTrap(rootRef, fullscreen)
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
      aria-labelledby={titleId}
      style={variant === 'floating' && !fullscreen ? anchor : undefined}
      className={clsx(
        'flex flex-col overflow-hidden text-text motion-safe:transition-all',
        // `relative` only in page mode: in floating modes it would override `fixed`.
        variant === 'page' ? 'relative h-full min-h-[480px] rounded-xl border border-border bg-card shadow-sm' : MODE_CLASSES[mode],
      )}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || variant !== 'floating' || !isOwnLayer(rootRef.current, e.target)) return
        e.stopPropagation()
        // The top-most layer closes: full screen drops to the expanded card, a floating card closes
        // (focus goes back to the launcher, AssistantRoot).
        if (fullscreen) setMode('expanded')
        else setOpen(false)
      }}
    >
      <PanelHeader
        titleId={titleId}
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
        {wide && <SessionsSidebar id={sidebarId} onNewChat={startNewChat} onPick={pick} />}
        {/* Keyed by thread: switching conversations resets scroll and composer state. */}
        <ConversationPane key={thread.threadId} column={wide ? WIDE_COLUMN : undefined} draft={draft} onDraft={setDraft} />
      </div>
      {showSessions && <SessionsDrawer onClose={() => setShowSessions(false)} onOpen={pick} />}
    </div>
  )
}
