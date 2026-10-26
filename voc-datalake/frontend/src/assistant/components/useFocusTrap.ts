/**
 * @fileoverview Keep Tab focus inside a container while `active` (fullscreen
 * mode), and move focus into it when it activates.
 *
 * @module assistant/components/useFocusTrap
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.classList.contains('hidden'))
}

function wrapFocus(container: HTMLElement, event: KeyboardEvent): void {
  const items = focusables(container)
  const first = items.at(0)
  const last = items.at(-1)
  if (first === undefined || last === undefined) return
  const active = document.activeElement
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const container = ref.current
    if (!active || container === null) return
    if (!container.contains(document.activeElement)) focusables(container)[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') wrapFocus(container, event)
    }
    container.addEventListener('keydown', onKeyDown)
    return () => container.removeEventListener('keydown', onKeyDown)
  }, [ref, active])
}
