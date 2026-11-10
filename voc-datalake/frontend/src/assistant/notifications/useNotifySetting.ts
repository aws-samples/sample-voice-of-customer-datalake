/**
 * @fileoverview The assistant's desktop-notification preference, shared by
 * the panel's bell (`NotifyToggle`) and Account → Assistant: both read and
 * write the SAME persisted store field (`voc-assistant-ui` `notify`), so they
 * can never disagree.
 *
 * Turning it on asks the browser for permission from that click (a prompt not
 * tied to a gesture is ignored or blocked). When the browser has blocked the
 * site, or has no Notification API, the setting is unavailable and says why.
 *
 * @module assistant/notifications/useNotifySetting
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAssistantUiStore } from '../store/assistantStore'
import { notificationAccess, requestNotificationAccess } from './runNotifications'
import type { NotificationAccess } from './runNotifications'

/** A permission prompt that fails (an old browser, a blocked frame) reads as a refusal. */
const deniedOnFailure = (): NotificationAccess => 'denied'

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

export interface NotifySetting {
  /** On, and the browser allows it. */
  on: boolean
  /** Blocked by the browser, or no Notification API. */
  unavailable: boolean
  /** What a press does, or why it cannot (namespace `assistant`). */
  label: string
  toggle: () => Promise<void>
}

export function useNotifySetting(): NotifySetting {
  const { t } = useTranslation('assistant')
  const notify = useAssistantUiStore((s) => s.notify)
  const setNotify = useAssistantUiStore((s) => s.setNotify)
  const [access, setAccess] = useNotificationAccess()
  const on = notify && access === 'granted'

  const toggle = async () => {
    if (on) {
      setNotify(false)
      return
    }
    const answer = await requestNotificationAccess().catch(deniedOnFailure)
    setAccess(answer)
    setNotify(answer === 'granted')
  }

  return { on, unavailable: access === 'unsupported' || access === 'denied', label: t(labelKey(access, on)), toggle }
}
