/**
 * @fileoverview A builder menu fixed in a portal (ui/ActionsMenu, questions/TypePicker): the menu button's state
 * (`components/ProfileMenu/useMenuButton`), the menu placed against its trigger when it opens (`utils/fixedMenu`) and
 * closed when a scroll moves the trigger or the window resizes, so a pane that scrolls on its own never clips it; and
 * `leaveOnTab`, which takes Tab / Shift+Tab out of the menu to the control after (before) the trigger, as if the menu
 * still sat beside it.
 *
 * @module pages/FeedbackForms/ui/useFixedMenu
 */
import { useLayoutEffect } from 'react'
import type { KeyboardEvent } from 'react'
import { useMenuButton } from '../../../components/ProfileMenu/useMenuButton'
import { useCloseOnViewportChange } from '../../../hooks/useCloseOnViewportChange'
import { placeFixedMenu, tabTargetFrom } from '../../../utils/fixedMenu'

/** `align`: the menu's start edge at the trigger's start (`start`), or its end edge at the trigger's end (`end`). */
export function useFixedMenu(align: 'start' | 'end') {
  const menu = useMenuButton()
  const { open, buttonRef, menuRef, close } = menu
  useCloseOnViewportChange(open, close, menuRef, buttonRef)
  useLayoutEffect(() => {
    const element = menuRef.current
    const button = buttonRef.current
    if (open && element !== null && button !== null) placeFixedMenu(element, button.getBoundingClientRect(), align)
  }, [open, menuRef, buttonRef, align])
  /** Tab in the open menu: closes it and moves on from the trigger. True when it handled the key. */
  const leaveOnTab = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const opener = buttonRef.current
    if (event.key !== 'Tab' || opener === null) return false
    event.preventDefault()
    close()
    tabTargetFrom(opener, event.shiftKey).focus()
    return true
  }
  return { ...menu, leaveOnTab }
}
