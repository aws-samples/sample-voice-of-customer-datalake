/**
 * @fileoverview Mounted once in `Layout`: the launcher button (bottom-right by
 * default; draggable with the pointer or the arrow keys, kept inside the
 * viewport and above sticky action bars — bubble/useLauncherPosition) and,
 * when open, the floating assistant panel beside it. Hidden on `/chat`, which
 * renders the same assistant (same thread) as the page itself.
 *
 * Layering (docs/kiro-design-system.md): launcher and panel are fixed siblings
 * of `<main>` — never give `<main>` or the shell a z-index. The launcher and
 * the floating panel sit at z-50; they come after the sidebar
 * `<aside>` (also z-50) in the DOM, so they paint above it and above the mobile
 * menu overlay (z-40). Fullscreen mode uses z-[60] so it always covers the
 * sidebar and the launcher. ModalShell dialogs (z-[70]) cover all three.
 *
 * @module assistant/components/AssistantRoot
 */
import { useEffect, useId, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { X } from 'lucide-react'
import KiroGhost from '../../components/KiroGhost/KiroGhost'
import { useAssistantUiStore } from '../store/assistantStore'
import { useLauncherPosition } from '../bubble/useLauncherPosition'
import { isChatRoute } from '../page/chatRoute'
import AssistantPanel from './AssistantPanel'

export default function AssistantRoot() {
  const { t } = useTranslation('assistant')
  const { pathname } = useLocation()
  const open = useAssistantUiStore((s) => s.open)
  const setOpen = useAssistantUiStore((s) => s.setOpen)
  const launcher = useLauncherPosition()
  const hintId = useId()
  const launcherRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(open)
  // Closing the panel from inside it (header X) unmounts the focused control;
  // put focus back on the launcher instead of dropping it on <body> (D-OVL).
  useEffect(() => {
    const closed = wasOpen.current && !open
    wasOpen.current = open
    const active = document.activeElement
    if (closed && (active === null || active === document.body)) launcherRef.current?.focus()
  }, [open])

  if (isChatRoute(pathname)) return null

  const { position, panelAnchor, moved, dragging, reset, handlers } = launcher
  return (
    <>
      {open && <AssistantPanel variant="floating" anchor={panelAnchor} onResetPosition={moved ? reset : undefined} />}
      <button
        ref={launcherRef}
        type="button"
        data-testid="assistant-launcher"
        onClick={(e) => {
          if (!handlers.consumeClick(e)) setOpen(!open)
        }}
        onPointerDown={handlers.onPointerDown}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
        onPointerCancel={handlers.onPointerCancel}
        onKeyDown={handlers.onKeyDown}
        aria-expanded={open}
        aria-label={open ? t('launcher.close') : t('launcher.open')}
        aria-describedby={hintId}
        title={open ? t('launcher.close') : t('launcher.open')}
        style={{ right: position.right, bottom: position.bottom }}
        className={clsx(
          'fixed z-50 flex h-12 w-12 touch-none select-none items-center justify-center rounded-full bg-accent text-accent-fg shadow-lg shadow-accent/30 hover:bg-accent-hover hover:shadow-[0_0_16px_var(--accent-glow)]',
          // No transition while dragging: the pressed state's duration would make
          // right/bottom ease behind the pointer on every move.
          dragging
            ? 'cursor-grabbing transition-none'
            : 'cursor-grab active:scale-[0.97] active:duration-75 motion-safe:transition-[right,bottom,background-color,box-shadow,transform]',
        )}
      >
        {open ? <X size={22} aria-hidden /> : <KiroGhost className="h-6 w-6" />}
      </button>
      <span id={hintId} className="sr-only">{t('launcher.moveHint')}</span>
    </>
  )
}
