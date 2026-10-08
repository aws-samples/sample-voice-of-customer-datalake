/**
 * @fileoverview The bell in the assistant header: opt in to desktop
 * notifications for conversations that need you while you are elsewhere.
 *
 * Turning it on asks the browser for permission from this click (a prompt not
 * tied to a gesture is ignored or blocked). When the browser has blocked the
 * site, or has no Notification API, the bell is disabled and says why.
 *
 * @module assistant/notifications/NotifyToggle
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff } from 'lucide-react'
import clsx from 'clsx'
import { useAssistantUiStore } from '../store/assistantStore'
import { notificationAccess, requestNotificationAccess } from './runNotifications'
import type { NotificationAccess } from './runNotifications'

function labelKey(access: NotificationAccess, on: boolean): string {
  if (access === 'unsupported') return 'notifications.toggle.unsupported'
  if (access === 'denied') return 'notifications.toggle.blocked'
  return on ? 'notifications.toggle.turnOff' : 'notifications.toggle.turnOn'
}

/** Current permission, re-read when the window regains focus (it can change in the browser settings). */
function useNotificationAccess(): [NotificationAccess, (access: NotificationAccess) => void] {
  const [access, setAccess] = useState<NotificationAccess>(notificationAccess)
  // Stryker disable ArrayDeclaration: a constant dependency never changes, so the effect still subscribes once per mount
  useEffect(() => {
    const refresh = () => setAccess(notificationAccess())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  // Stryker restore ArrayDeclaration
  return [access, setAccess]
}

export default function NotifyToggle({ className }: Readonly<{ className?: string }>) {
  const { t } = useTranslation('assistant')
  const notify = useAssistantUiStore((s) => s.notify)
  const setNotify = useAssistantUiStore((s) => s.setNotify)
  const [access, setAccess] = useNotificationAccess()
  const on = notify && access === 'granted'
  const unavailable = access === 'unsupported' || access === 'denied'
  const label = t(labelKey(access, on))

  const toggle = async () => {
    if (on) {
      setNotify(false)
      return
    }
    const answer = await requestNotificationAccess().catch((): NotificationAccess => 'denied')
    setAccess(answer)
    setNotify(answer === 'granted')
  }

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={unavailable}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={clsx('icon-btn', on && 'text-accent-text', className)}
    >
      {on ? <Bell size={16} aria-hidden /> : <BellOff size={16} aria-hidden />}
    </button>
  )
}
