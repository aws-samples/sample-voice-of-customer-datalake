/**
 * @fileoverview A menu button's menu in a portal at a fixed position (utils/fixedMenu.ts): placed under its trigger
 * while open (`align`: its left or its right edge on the trigger's), closed when a scroll moves the trigger or the window
 * resizes (hooks/useCloseOnViewportChange), and its key handler: the menu sits at the end of the page, so Tab closes it and goes
 * on from the trigger, as if the menu were still beside it; every other key is `onKey`'s (the menu button's arrows,
 * Home, End and Escape, a type-ahead). The row ⋯ menu, the forms builder's ⋯ menus and its question type picker.
 *
 * @module hooks/usePortalMenu
 */
import { useLayoutEffect } from 'react'
import type { KeyboardEvent } from 'react'
import { placeFixedMenu, tabTargetFrom } from '../utils/fixedMenu'
import type { useMenuButton } from '../components/ProfileMenu/useMenuButton'
import { useCloseOnViewportChange } from './useCloseOnViewportChange'

type PortalMenuButton = Pick<ReturnType<typeof useMenuButton>, 'open' | 'close' | 'buttonRef' | 'menuRef'>

export function usePortalMenu({ open, close, buttonRef, menuRef }: PortalMenuButton, align: 'start' | 'end',
  onKey: (event: KeyboardEvent<HTMLDivElement>) => void): (event: KeyboardEvent<HTMLDivElement>) => void {
  useCloseOnViewportChange(open, close, menuRef, buttonRef)
  useLayoutEffect(() => {
    const menu = menuRef.current
    const button = buttonRef.current
    if (open && menu !== null && button !== null) placeFixedMenu(menu, button.getBoundingClientRect(), align)
  }, [open, menuRef, buttonRef, align])
  return (event) => {
    const opener = buttonRef.current
    if (event.key === 'Tab' && opener !== null) {
      event.preventDefault()
      close()
      tabTargetFrom(opener, event.shiftKey).focus()
      return
    }
    onKey(event)
  }
}
