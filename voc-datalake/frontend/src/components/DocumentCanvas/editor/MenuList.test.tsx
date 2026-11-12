import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Copy, Trash2 } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import MenuList, { type MenuItem } from './MenuList'

function renderMenu(items: Partial<Omit<MenuItem, 'onSelect'>>[] = [{}, {}, {}]) {
  const onClose = vi.fn()
  const full = items.map((item, index) => ({ id: `item-${String(index)}`, label: `Item ${String(index + 1)}`, icon: Copy, ...item, onSelect: vi.fn() }))
  render(<MenuList label="Block actions" items={full} onClose={onClose} />)
  const menu = screen.getByRole('menu', { name: 'Block actions' })
  return { menu, items: full, onClose, item: (name: string) => within(menu).getByRole('menuitem', { name }) }
}

describe('MenuList', () => {
  it('is a labelled menu that focuses its first enabled item', () => {
    const { item } = renderMenu([{ disabled: true }, {}, {}])
    expect(item('Item 1')).toBeDisabled()
    expect(item('Item 2')).toHaveFocus()
  })

  it('moves with the arrows (wrapping), Home and End, and skips disabled items', () => {
    const { menu } = renderMenu([{}, { disabled: true }, {}, {}])
    const focused = () => document.activeElement?.textContent
    const visited = [focused(), ...['ArrowDown', 'End', 'ArrowDown', 'ArrowUp', 'Home'].map((key) => {
      fireEvent.keyDown(menu, { key })
      return focused()
    })]
    expect(visited).toStrictEqual(['Item 1', 'Item 3', 'Item 4', 'Item 1', 'Item 4', 'Item 1'])
  })

  it('leaves other keys to the page', () => {
    const { menu, item } = renderMenu()
    expect(fireEvent.keyDown(menu, { key: 'a' })).toBe(true)
    expect(item('Item 1')).toHaveFocus()
  })

  it.each(['Escape', 'Tab'])('closes on %s, and the key goes no further', (key) => {
    const onParentKey = vi.fn()
    const onClose = vi.fn()
    render(
      <div onKeyDown={onParentKey}>
        <MenuList label="Menu" items={[{ id: 'a', label: 'A', icon: Copy, onSelect: vi.fn() }]} onClose={onClose} />
      </div>,
    )
    expect(fireEvent.keyDown(screen.getByRole('menu'), { key })).toBe(false)
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
    expect(onParentKey).not.toHaveBeenCalled()
  })

  it('chooses an item with a click, Enter or Space, and keeps the focus where it was on a press', async () => {
    const user = userEvent.setup()
    const { items, item } = renderMenu()
    await user.click(item('Item 2'))
    item('Item 3').focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(items.map(({ onSelect }) => onSelect.mock.calls.length)).toStrictEqual([0, 1, 2])
    expect(fireEvent.mouseDown(item('Item 1'))).toBe(false)
  })

  it('announces an item that opens a submenu, and hides the icons from screen readers', () => {
    const { item } = renderMenu([{ icon: Trash2 }, { submenu: true }])
    expect(item('Item 2')).toHaveAttribute('aria-haspopup', 'menu')
    expect(item('Item 1')).not.toHaveAttribute('aria-haspopup')
    expect(item('Item 1').querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(item('Item 1')).toHaveAttribute('tabindex', '-1')
  })

  it('moves focus nowhere when every item is disabled', () => {
    const { menu } = renderMenu([{ disabled: true }, { disabled: true }])
    expect(fireEvent.keyDown(menu, { key: 'ArrowDown' })).toBe(true)
    expect(document.body).toHaveFocus()
  })

  it('focuses the first item again when the items change (a submenu opens)', () => {
    const onClose = vi.fn()
    const first = [{ id: 'a', label: 'A', icon: Copy, onSelect: vi.fn() }, { id: 'b', label: 'B', icon: Copy, onSelect: vi.fn() }]
    const { rerender } = render(<MenuList label="Menu" items={first} onClose={onClose} />)
    screen.getByRole('menuitem', { name: 'B' }).focus()
    rerender(<MenuList label="Sub" items={[{ id: 'c', label: 'C', icon: Copy, onSelect: vi.fn() }]} onClose={onClose} />)
    expect(screen.getByRole('menuitem', { name: 'C' })).toHaveFocus()
  })
})
