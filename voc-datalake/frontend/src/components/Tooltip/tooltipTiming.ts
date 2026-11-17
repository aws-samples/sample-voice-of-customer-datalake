/**
 * @fileoverview When a tooltip opens and closes: one timing for every Tooltip, InfoTip and TruncatedText.
 *
 * - A mouse or pen resting on the trigger opens it after {@link OPEN_DELAY_MS}; a pointer that only crosses
 *   the trigger opens nothing.
 * - **The delay group:** while another tooltip is open, or less than {@link SKIP_DELAY_MS} after one closed,
 *   it opens at once (moving along a toolbar).
 * - Keyboard focus opens it at once (useTooltip.ts decides what counts: Tab or an arrow, `:focus-visible`); the
 *   focus a press brings does not.
 * - It closes {@link CLOSE_DELAY_MS} after the pointer leaves, and stays open while the pointer is on the
 *   bubble (hoverable, WCAG 1.4.13). Escape, blur and a press close it at once.
 * - Touch never opens it: a tap performs the action. Only an InfoTip pins open, on a click or a tap.
 * - **One at a time:** opening a tooltip closes the one that was open.
 *
 * @module components/Tooltip/tooltipTiming
 */

/** How long a mouse rests on a trigger before its tooltip opens. */
export const OPEN_DELAY_MS = 80
/** A tooltip opened this soon after another closed skips the delay. */
export const SKIP_DELAY_MS = 300
/** How long a tooltip stays after the pointer leaves its trigger and its bubble. */
export const CLOSE_DELAY_MS = 100

export interface TooltipTimer {
  /** A pointer came onto the trigger or the bubble (`PointerEvent.pointerType`). */
  readonly pointerEnter: (pointerType: string) => void
  readonly pointerLeave: () => void
  /** The trigger was pressed: its action runs and the tooltip goes, unless it is pinned. */
  readonly press: () => void
  /** The trigger took focus; `visible` when it was keyboard focus (`:focus-visible`). */
  readonly focus: (visible: boolean) => void
  readonly blur: () => void
  /** An InfoTip's click or tap: pins the tooltip open, or unpins and closes it. */
  readonly togglePin: () => void
  /** Escape, or a press outside: closes now. */
  readonly dismiss: () => void
  /** The trigger unmounts. */
  readonly dispose: () => void
}

interface GroupMember {
  readonly closeNow: () => void
}

/** The page's one open tooltip, and when the last one closed. */
const group: { open: GroupMember | null; closedAt: number } = { open: null, closedAt: Number.NEGATIVE_INFINITY }

function openDelay(): number {
  return group.open !== null || Date.now() - group.closedAt < SKIP_DELAY_MS ? 0 : OPEN_DELAY_MS
}

interface TimerState {
  timer: ReturnType<typeof setTimeout> | null
  open: boolean
  pinned: boolean
  /** A press is under way (pointer down until it leaves or the trigger blurs): no hover or focus opening. */
  pressed: boolean
  focused: boolean
}

/** The timing of one tooltip; `setOpen` is told each change. */
export function createTooltipTimer(setOpen: (open: boolean) => void): TooltipTimer {
  const state: TimerState = { timer: null, open: false, pinned: false, pressed: false, focused: false }
  const clear = () => {
    if (state.timer !== null) clearTimeout(state.timer)
    state.timer = null
  }
  const close = () => {
    clear()
    state.pinned = false
    if (!state.open) return
    state.open = false
    if (group.open === member) {
      group.open = null
      group.closedAt = Date.now()
    }
    setOpen(false)
  }
  const member: GroupMember = { closeNow: close }
  const show = () => {
    clear()
    if (state.open) return
    if (group.open !== null && group.open !== member) group.open.closeNow()
    group.open = member
    state.open = true
    setOpen(true)
  }
  const later = (run: () => void, ms: number) => {
    clear()
    state.timer = setTimeout(run, ms)
  }
  return {
    pointerEnter: (pointerType) => {
      if (pointerType === 'touch' || state.pressed) return
      const delay = state.open ? 0 : openDelay()
      if (delay === 0) show()
      else later(show, delay)
    },
    pointerLeave: () => {
      state.pressed = false
      if (state.open && !state.pinned && !state.focused) later(close, CLOSE_DELAY_MS)
      else clear()
    },
    press: () => {
      state.pressed = true
      if (!state.pinned) close()
    },
    focus: (visible) => {
      state.focused = true
      if (visible && !state.pressed) show()
    },
    blur: () => {
      state.focused = false
      state.pressed = false
      close()
    },
    togglePin: () => {
      if (state.pinned) {
        close()
        return
      }
      show()
      state.pinned = state.open
    },
    dismiss: close,
    dispose: () => {
      clear()
      if (group.open === member) group.open = null
    },
  }
}
