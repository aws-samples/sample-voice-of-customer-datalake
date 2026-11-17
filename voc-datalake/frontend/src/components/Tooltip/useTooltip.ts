/**
 * @fileoverview The React side of a tooltip's timing (tooltipTiming.ts): its open state, Escape while it is
 * open, and the handlers its trigger takes.
 *
 * @module components/Tooltip/useTooltip
 */
import { useEffect, useState } from 'react'
import { noCleanup } from '../../hooks/noCleanup'
import { createTooltipTimer } from './tooltipTiming'
import type { FocusEvent, PointerEvent } from 'react'
import type { TooltipTimer } from './tooltipTiming'

interface TooltipState {
  readonly open: boolean
  readonly timer: TooltipTimer
}

/** An element that takes Escape itself (an inline rename cancels on it). */
function takesEscape(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select'))
}

/**
 * One tooltip's state. While it is open, Escape anywhere closes it without moving focus, and goes no
 * further: the dialog or menu under the tooltip stays open (the top-most layer takes Escape). A text
 * field keeps its own Escape: the tooltip closes and the key goes on to the field.
 */
export function useTooltip(): TooltipState {
  const [open, setOpen] = useState(false)
  const [timer] = useState(() => createTooltipTimer(setOpen))
  useEffect(() => {
    watchNavigation()
    return () => timer.dispose()
  }, [timer])
  useEffect(() => {
    if (!open) return noCleanup
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!takesEscape(event.target)) event.stopPropagation()
      timer.dismiss()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, timer])
  return { open, timer }
}

/** The keys that move focus: Tab, and a toolbar's or a list's arrows, Home and End. */
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** Whether the last key pressed moved focus (no pointer since), read once per page. */
const keyboard = { navigating: false, watching: false }

function watchNavigation(): void {
  if (keyboard.watching) return
  keyboard.watching = true
  document.addEventListener('keydown', (event) => {
    keyboard.navigating = NAVIGATION_KEYS.has(event.key)
  }, true)
  document.addEventListener('pointerdown', () => {
    keyboard.navigating = false
  }, true)
}

/**
 * Focus a person moved with the keyboard (`:focus-visible`, after Tab or an arrow). Not the focus a dialog
 * gives its first control as it opens, even when Enter opened it: that tooltip would take the Escape meant
 * for the dialog. A browser that cannot match `:focus-visible` counts every such focus as visible.
 */
function isKeyboardFocus(element: Element): boolean {
  if (!keyboard.navigating) return false
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/** What a trigger listens to. */
interface TriggerHandlers {
  readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void
  readonly onPointerLeave: () => void
  readonly onPointerDown: () => void
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void
  readonly onBlur: () => void
}

export function triggerHandlers(timer: TooltipTimer): TriggerHandlers {
  return {
    onPointerEnter: (event) => timer.pointerEnter(event.pointerType),
    onPointerLeave: () => timer.pointerLeave(),
    onPointerDown: () => timer.press(),
    onFocus: (event) => timer.focus(isKeyboardFocus(event.currentTarget)),
    onBlur: () => timer.blur(),
  }
}
