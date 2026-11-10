/**
 * @fileoverview Navigating to another route from somewhere that can sit above the page (the
 * full-screen assistant, the review modal). The full-screen assistant covers the page, so a
 * real route change there would happen behind it: it shows the expanded panel for now (without
 * changing the user's stored mode), and the user sees the page they asked for with the
 * conversation still beside it. On a phone
 * (below `sm`) the floating panel is itself a sheet over the whole page, so it closes instead —
 * the launcher brings the same conversation back.
 *
 * @module hooks/useRouteNavigate
 */
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssistantUiStore } from '../assistant/store/assistantStore'

/** Below Tailwind's `sm` the floating panel is a full-screen sheet (AssistantPanel NARROW_SHEET). */
const NARROW_VIEWPORT = '(max-width: 639.98px)'

function isNarrowViewport(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_VIEWPORT).matches
}

/**
 * Uncover the page: show full screen as the expanded panel for now (the stored mode stays full
 * screen — the user's choice — and comes back on the next open, a reload or the Full screen
 * button), or close the phone sheet.
 */
function leaveAssistantFullscreen(): void {
  const { mode, uncover, setOpen } = useAssistantUiStore.getState()
  if (isNarrowViewport()) setOpen(false)
  else if (mode === 'fullscreen') uncover()
}

/**
 * A route `<Link>`'s onClick: a plain click changes the route here, so leave full screen; a
 * modified click (new tab / window) leaves this tab alone.
 */
export function leaveFullscreenOnPlainClick(event: Readonly<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>): void {
  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) leaveAssistantFullscreen()
}

/** `navigate(to)` for a real route change, after {@link leaveAssistantFullscreen}. */
export function useRouteNavigate(): (to: string) => void {
  const navigate = useNavigate()
  return useCallback((to: string) => {
    leaveAssistantFullscreen()
    void navigate(to)
  }, [navigate])
}
