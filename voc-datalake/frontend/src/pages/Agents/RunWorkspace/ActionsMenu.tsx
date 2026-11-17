/**
 * @fileoverview A small menu button for the run workspace's controls (7.51.00): the WAI-ARIA menu button pattern of
 * the app's header menus (components/ProfileMenu/useMenuButton.ts: focus into the menu, arrow keys, Escape back to
 * the button), its items in the `menu` / `menu-item` recipe. Used for "More ways to stop" and the ⋯ menus.
 *
 * @module pages/Agents/RunWorkspace/ActionsMenu
 */
import { useId } from 'react'
import clsx from 'clsx'
import { menuButtonParts, useMenuButton } from '../../../components/ProfileMenu/useMenuButton'
import type { ReactNode } from 'react'

export interface MenuAction {
  readonly id: string
  readonly label: string
  readonly onSelect: () => void
  /** A destructive action (in the danger tone). */
  readonly danger?: boolean
}

export function ActionsMenu({ label, face, actions, buttonClassName }: Readonly<{
  /** The button's and the menu's accessible name. */
  label: string
  face: ReactNode
  actions: readonly MenuAction[]
  buttonClassName: string
}>) {
  const menu = useMenuButton()
  const menuId = useId()
  const parts = menuButtonParts(menu, menuId, label)
  return (
    <span className="relative inline-flex">
      <button {...parts.trigger} className={buttonClassName}>{face}</button>
      {menu.open && (
        <div {...parts.list} className="menu absolute right-0 top-full mt-1 w-max max-w-[18rem]">
          {actions.map((action) => (
            <button key={action.id} type="button" role="menuitem" className={clsx('menu-item', action.danger === true && 'text-danger')}
              onClick={() => {
                menu.close(true)
                action.onSelect()
              }}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
