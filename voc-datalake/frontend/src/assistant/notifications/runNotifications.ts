/**
 * @fileoverview Desktop notifications for assistant runs that end while the
 * user is not looking: an approval is needed, a reply is ready, or a run failed.
 *
 * Browser Notification API only — no push service, no service worker, nothing
 * leaves the browser — so they arrive while the app is open in some tab, not
 * after it is closed. Opt-in (the bell in the assistant header) and only when
 * the browser has granted permission. Same rules as the kiro-acp-bridge
 * notifier: bodies are generic, because a notification can show on a lock
 * screen, so no conversation title, question or answer text is ever included.
 *
 * @module assistant/notifications/runNotifications
 */
import i18n from 'i18next'
import type { ThreadState } from '../thread/types'

type NoticeKind = 'approval' | 'reply' | 'failed'
/** A plan's run (docs/assistant-plan-mode.md): finished cleanly, finished with problems, or a step waits for approval. */
type PlanNoticeKind = 'planDone' | 'planIssues' | 'planApproval'

export type NotificationAccess = 'unsupported' | 'denied' | 'granted' | 'default'

function api(): typeof Notification | undefined {
  return typeof window.Notification === 'function' ? window.Notification : undefined
}

export function notificationAccess(): NotificationAccess {
  const Api = api()
  return Api === undefined ? 'unsupported' : Api.permission
}

/**
 * Ask the browser for permission. Call it from the user's click: browsers
 * ignore (or block) prompts that are not tied to a gesture.
 */
export async function requestNotificationAccess(): Promise<NotificationAccess> {
  const Api = api()
  if (Api === undefined) return 'unsupported'
  if (Api.permission !== 'default') return Api.permission
  return Api.requestPermission()
}

/** What a finished run should announce, from the status it ended in. */
function noticeFor(thread: Pick<ThreadState, 'status'>): NoticeKind | null {
  switch (thread.status) {
    case 'awaiting_approval':
      return 'approval'
    case 'idle':
      return 'reply'
    case 'error':
      return 'failed'
    default:
      return null
  }
}

function tabInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

interface AnnounceOptions {
  enabled: boolean
  /** The thread is the one in view, in an open panel or on `/chat`. */
  threadOnScreen: boolean
  /** Bring the conversation into view (called when the notification is clicked). */
  onOpen: () => void
}

/**
 * Announce a run that just ended, unless the user is already looking at it.
 * One tag per thread and kind, so a burst of runs replaces rather than stacks.
 * Returns whether a notification was shown.
 */
export function announceRunEnd(threadId: string, thread: Pick<ThreadState, 'status'>, options: AnnounceOptions): boolean {
  const Api = api()
  const kind = noticeFor(thread)
  if (!options.enabled || Api?.permission !== 'granted' || kind === null) return false
  if (options.threadOnScreen && tabInFront()) return false
  return showNotice(Api, kind, `voc-assistant:${threadId}:${kind}`, kind === 'approval', options.onOpen)
}

/** Show one generic notice (title + body from the `assistant:notifications.<kind>` keys). */
function showNotice(Api: typeof Notification, kind: NoticeKind | PlanNoticeKind, tag: string, requireInteraction: boolean, onOpen: () => void): boolean {
  try {
    const notification = new Api(i18n.t(`assistant:notifications.${kind}.title`), {
      body: i18n.t(`assistant:notifications.${kind}.body`),
      tag,
      requireInteraction,
    })
    notification.onclick = () => {
      window.focus()
      onOpen()
      notification.close()
    }
    return true
  } catch {
    // Chrome on Android allows notifications only through a service worker and
    // throws here; the in-app unread/approval markers still show.
    return false
  }
}

/** What a plan's change of state should announce: its end, or a step that now needs approval. */
export type PlanNotice = 'done' | 'issues' | 'approval'

const PLAN_NOTICE_KINDS: Record<PlanNotice, PlanNoticeKind> = { done: 'planDone', issues: 'planIssues', approval: 'planApproval' }

/**
 * Announce a plan that finished (or now waits for an approval) while the tab is
 * not in front. One tag per plan and kind. Returns whether a notification was shown.
 */
export function announcePlanChange(planId: string, notice: PlanNotice, options: Pick<AnnounceOptions, 'enabled' | 'onOpen'>): boolean {
  const Api = api()
  if (!options.enabled || Api?.permission !== 'granted' || tabInFront()) return false
  const kind = PLAN_NOTICE_KINDS[notice]
  return showNotice(Api, kind, `voc-assistant:plan:${planId}:${kind}`, notice === 'approval', options.onOpen)
}
