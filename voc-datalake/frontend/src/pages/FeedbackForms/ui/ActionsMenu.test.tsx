/**
 * The builder's ⋯ menus (ui/ActionsMenu, on ui/useFixedMenu): a named trigger, or a text one with `face`; the menu
 * fixed in a portal outside the page, its items with their icons, separators and the danger tone; an item that is
 * off says why and does nothing; a pick closes the menu with the focus back on the trigger, then runs; Tab leaves
 * the menu for the control after the trigger; the page scrolling closes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Copy, Trash2 } from 'lucide-react'
import ActionsMenu from './ActionsMenu'
import type { MenuAction } from './ActionsMenu'

function renderMenu(items: readonly (MenuAction | null)[], extra: Partial<Parameters<typeof ActionsMenu>[0]> = {}) {
  const view = render(
    <div>
      <ActionsMenu label="More actions for question 1" items={items} {...extra} />
      <button type="button">After the menu</button>
    </div>,
  )
  return { ...view, user: userEvent.setup() }
}

describe('ActionsMenu', () => {
  it('opens a fixed menu outside the page from its named ⋯, items and separators in order', async () => {
    const { user, container } = renderMenu([
      { label: 'Duplicate', icon: Copy, onSelect: vi.fn() },
      null,
      { label: 'Delete…', icon: Trash2, danger: true, onSelect: vi.fn() },
    ])
    const trigger = screen.getByRole('button', { name: 'More actions for question 1' })
    expect([trigger.title, trigger.getAttribute('aria-expanded')]).toStrictEqual(['More actions for question 1', 'false'])
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'More actions for question 1' })
    expect([container.contains(menu), menu.classList.contains('fixed'), trigger.getAttribute('aria-controls') === menu.id]).toStrictEqual([false, true, true])
    expect([...menu.children].map((child) => child.getAttribute('role'))).toStrictEqual(['menuitem', 'separator', 'menuitem'])
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveClass('text-danger')
  })

  it('runs a pick after closing the menu, with the focus back on its trigger', async () => {
    const onSelect = vi.fn<() => void>()
    const { user } = renderMenu([{ label: 'Duplicate', onSelect }])
    const trigger = screen.getByRole('button', { name: 'More actions for question 1' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect([onSelect.mock.calls.length, screen.queryByRole('menu') === null, document.activeElement === trigger]).toStrictEqual([1, true, true])
  })

  it('keeps an item that is off in the menu with its reason, and pressing it does nothing', async () => {
    const onSelect = vi.fn<() => void>()
    const { user } = renderMenu([{ label: 'Delete form', disabledReason: 'Save the form first.', onSelect }])
    await user.click(screen.getByRole('button', { name: 'More actions for question 1' }))
    const item = screen.getByRole('menuitem', { name: /^Delete form/ })
    await user.click(item)
    expect([item.getAttribute('aria-disabled'), item.textContent, onSelect.mock.calls.length]).toStrictEqual(['true', 'Delete formSave the form first.', 0])
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('leaves the menu on Tab for the control after its trigger, as if it still sat beside it', async () => {
    const { user } = renderMenu([{ label: 'Duplicate', onSelect: vi.fn() }])
    await user.click(screen.getByRole('button', { name: 'More actions for question 1' }))
    screen.getByRole('menuitem', { name: 'Duplicate' }).focus()
    await user.keyboard('{Tab}')
    expect([screen.queryByRole('menu') === null, document.activeElement?.textContent]).toStrictEqual([true, 'After the menu'])
  })

  it('moves with the arrow keys, and closes when a scroll moves its trigger (not on one that leaves it put)', async () => {
    const { user } = renderMenu([{ label: 'Duplicate', onSelect: vi.fn() }, { label: 'Move down', onSelect: vi.fn() }])
    const trigger = screen.getByRole('button', { name: 'More actions for question 1' })
    const triggerAt = (top: number) => vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(300, top, 28, 28))
    triggerAt(400)
    await user.click(trigger)
    screen.getByRole('menuitem', { name: 'Duplicate' }).focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toHaveFocus()
    fireEvent.scroll(window)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    triggerAt(320)
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('is a text menu button with a face: its words show, no title', async () => {
    const { user } = renderMenu([{ label: 'Phone · 390 × 844', onSelect: vi.fn() }], {
      label: 'Open in window', face: <>Open in window ▾</>, faceClassName: 'btn btn-ghost btn-sm',
    })
    const trigger = screen.getByRole('button', { name: 'Open in window' })
    expect([trigger.textContent, trigger.title, trigger.className]).toStrictEqual(['Open in window ▾', '', 'btn btn-ghost btn-sm'])
    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Phone · 390 × 844' })).toBeInTheDocument()
  })
})
