/**
 * The forms builder's ⋯ menu: an icon button named by its label opens a WAI-ARIA menu in a portal (its first item takes
 * the focus, Escape returns to the button); an item that is off says why under its label, stays focusable and does
 * nothing; choosing one closes the menu and runs it; separators split the groups; Tab leaves for the control after
 * the button.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Copy, Trash2 } from 'lucide-react'
import { expectTabLeavesTheMenu } from '@test/keyboard'
import ActionsMenu from './ActionsMenu'
import type { MenuAction } from './ActionsMenu'

const LABEL = 'More actions for question 2'

function renderMenu(items: readonly (MenuAction | null)[]) {
  render(<><ActionsMenu label={LABEL} items={items} /><button type="button">Next control</button></>)
  return { user: userEvent.setup(), trigger: screen.getByRole('button', { name: LABEL }) }
}

describe('ActionsMenu', () => {
  it('opens a menu named by its button, whose first item takes the focus', async () => {
    const { user, trigger } = renderMenu([{ label: 'Duplicate', icon: Copy, onSelect: vi.fn() }])
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: LABEL })
    expect([trigger.getAttribute('aria-expanded'), trigger.getAttribute('aria-controls')]).toStrictEqual(['true', menu.id])
    expect(within(menu).getByRole('menuitem', { name: 'Duplicate' })).toHaveFocus()
  })

  it('splits its groups with a separator and marks a dangerous item', async () => {
    const { user, trigger } = renderMenu([{ label: 'Duplicate', icon: Copy, onSelect: vi.fn() }, null,
      { label: 'Delete', icon: Trash2, danger: true, onSelect: vi.fn() }])
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: LABEL })
    expect(within(menu).getAllByRole('separator')).toHaveLength(1)
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveClass('text-danger')
  })

  it('closes back to its button on Escape', async () => {
    const { user, trigger } = renderMenu([{ label: 'Duplicate', onSelect: vi.fn() }])
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('keeps an item that is off, with its reason, doing nothing', async () => {
    const remove = vi.fn<() => void>()
    const { user, trigger } = renderMenu([{ label: 'Delete', onSelect: remove, disabledReason: 'A form keeps at least one question' }])
    await user.click(trigger)
    const off = screen.getByRole('menuitem', { name: /Delete/ })
    expect([off.getAttribute('aria-disabled'), off.textContent]).toStrictEqual(['true', 'DeleteA form keeps at least one question'])
    await user.click(off)
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByRole('menu', { name: LABEL })).toBeInTheDocument()
  })

  it('runs a chosen item once closed', async () => {
    const duplicate = vi.fn<() => void>()
    const { user, trigger } = renderMenu([{ label: 'Duplicate', onSelect: duplicate }])
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(duplicate).toHaveBeenCalledExactlyOnceWith()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('leaves for the control after its button on Tab, closed', async () => {
    const { user, trigger } = renderMenu([{ label: 'Duplicate', onSelect: vi.fn() }])
    await user.click(trigger)
    await expectTabLeavesTheMenu(user, 'Next control')
  })
})
