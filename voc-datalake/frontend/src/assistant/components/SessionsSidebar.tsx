/**
 * @fileoverview The permanent conversation list on wide panels (`/chat`, full
 * screen) from `lg` up; below that the header's history button opens the
 * drawer instead (SessionsDrawer).
 *
 * Like the app's main menu it collapses to a narrow rail (New conversation +
 * expand), with the same PanelLeftClose / PanelLeft icons. The choice is a
 * persisted UI preference (`sessionsCollapsed` in the assistant UI store), so
 * it survives a reload and applies to both wide presentations.
 *
 * @module assistant/components/SessionsSidebar
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { PanelLeft, PanelLeftClose, Plus } from 'lucide-react'
import { useAssistantUiStore } from '../store/assistantStore'
import SessionList from './SessionList'
import type { RefObject } from 'react'

interface SessionsSidebarProps {
  /** The nav's id, referenced by its own collapse toggle (`aria-controls`). */
  id: string
  onNewChat: () => void
  onPick: (id: string) => void
}

/**
 * The collapse / expand button moves between the rail and the full list, so
 * React mounts a new element: put focus back on it when it had it, or a
 * keyboard user would be dropped to the top of the page.
 */
function useToggleFocus(collapsed: boolean) {
  const toggleRef = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    toggleRef.current?.focus()
  }, [collapsed])
  return { toggleRef, markRefocus: () => { refocus.current = true } }
}

/** Collapse / expand, styled like the main menu's "Collapse sidebar" (icon + native tooltip). */
function CollapseToggle({ collapsed, controls, onToggle, buttonRef }: Readonly<{
  collapsed: boolean
  controls: string
  onToggle: () => void
  buttonRef: RefObject<HTMLButtonElement | null>
}>) {
  const { t } = useTranslation('assistant')
  const label = collapsed ? t('sessions.expandSidebar') : t('sessions.collapseSidebar')
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onToggle}
      className="icon-btn flex-shrink-0"
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      aria-controls={controls}
    >
      {collapsed ? <PanelLeft size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
    </button>
  )
}

export default function SessionsSidebar({ id, onNewChat, onPick }: Readonly<SessionsSidebarProps>) {
  const { t } = useTranslation('assistant')
  const collapsed = useAssistantUiStore((s) => s.sessionsCollapsed)
  const setCollapsed = useAssistantUiStore((s) => s.setSessionsCollapsed)
  const { toggleRef, markRefocus } = useToggleFocus(collapsed)
  const toggle = (
    <CollapseToggle
      collapsed={collapsed}
      controls={id}
      buttonRef={toggleRef}
      onToggle={() => {
        markRefocus()
        setCollapsed(!collapsed)
      }}
    />
  )
  return (
    <nav
      id={id}
      data-collapsed={collapsed}
      className={clsx(
        'hidden flex-shrink-0 flex-col border-r border-border bg-bg-elevated motion-safe:transition-[width] lg:flex',
        collapsed ? 'w-12 items-center' : 'w-64 xl:w-72',
      )}
      aria-label={t('sessions.sidebar')}
    >
      {/* The sidebar's own title, so its group headings sit one level below it
          rather than jumping from the page's h1 to an h4 (E2E F9). */}
      <h2 className="sr-only">{t('sessions.sidebar')}</h2>
      {collapsed
        ? (
          <div className="flex flex-col items-center gap-1 py-2">
            {toggle}
            <button type="button" onClick={onNewChat} className="icon-btn" aria-label={t('sessions.newConversation')} title={t('sessions.newConversation')}>
              <Plus size={16} aria-hidden />
            </button>
          </div>
        )
        : (
          <>
            <div className="flex flex-shrink-0 items-center gap-1 p-2">
              <button type="button" onClick={onNewChat} className="btn btn-secondary min-w-0 flex-1 justify-center">
                <Plus size={14} aria-hidden />
                {t('sessions.newConversation')}
              </button>
              {toggle}
            </div>
            <div className="flex-1 overflow-y-auto">
              <SessionList onPick={onPick} groupHeadingLevel={3} />
            </div>
          </>
        )}
    </nav>
  )
}
