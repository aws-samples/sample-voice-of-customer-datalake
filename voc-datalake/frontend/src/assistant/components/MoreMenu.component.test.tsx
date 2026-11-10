/**
 * The "More actions" menu button (wave 4): visible labels for every action, and the WAI-ARIA
 * menu button keyboard contract — arrows open and move, Escape closes it, returns focus to the
 * trigger and stops there (the assistant panel behind it stays open).
 */
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import MoreMenu from './MoreMenu'
import type { MoreMenuItem } from './MoreMenu'

function setup(extra: Partial<MoreMenuItem> = {}) {
  const exportIt = vi.fn()
  const notify = vi.fn()
  const parentKeys = vi.fn()
  const items: MoreMenuItem[] = [
    { key: 'export', label: 'Export conversation (Markdown)', icon: null, onSelect: exportIt },
    { key: 'notify', label: 'Notify me when a conversation needs me', icon: null, onSelect: notify, checked: false, ...extra },
    { key: 'reset', label: 'Reset assistant button position', icon: null, onSelect: vi.fn() },
  ]
  const { container } = render(<div><MoreMenu label="More actions" items={items} /></div>)
  // A parent that closes on Escape, like the floating assistant panel.
  container.firstElementChild?.addEventListener('keydown', (event) => {
    if (event instanceof KeyboardEvent) parentKeys(event.key)
  })
  return { user: userEvent.setup(), exportIt, notify, parentKeys, trigger: screen.getByRole('button', { name: 'More actions' }) }
}

/** A one-item menu for the placement and dismissal tests. */
const exportOnly = (): MoreMenuItem[] => [{ key: 'export', label: 'Export', icon: null, onSelect: vi.fn() }]

describe('MoreMenu', () => {
  it('is a labelled menu button whose items carry visible labels', async () => {
    const { user, trigger } = setup()
    expect([trigger.getAttribute('aria-haspopup'), trigger.getAttribute('aria-expanded'), trigger.getAttribute('title')])
      .toStrictEqual(['menu', 'false', 'More actions'])
    await user.click(trigger)
    expect([...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent)).toStrictEqual([
      'Export conversation (Markdown)', 'Notify me when a conversation needs me', 'Reset assistant button position',
    ])
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('opens with ArrowDown on the first item and moves with the arrows, Home and End', async () => {
    const { user, trigger } = setup()
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Export conversation (Markdown)' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Reset assistant button position' })).toHaveFocus()
    await user.keyboard('{Home}{ArrowDown}')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Notify me when a conversation needs me' })).toHaveFocus()
  })

  it('Escape closes it, puts focus back on the trigger and never reaches the panel behind', async () => {
    const { user, trigger, parentKeys } = setup()
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(parentKeys).not.toHaveBeenCalledWith('Escape')
  })

  it('runs the chosen item once and closes; a toggle says whether it is on', async () => {
    const { user, trigger, exportIt } = setup({ checked: true })
    await user.click(trigger)
    expect(screen.getByRole('menuitemcheckbox', { name: 'Notify me when a conversation needs me' })).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('menuitem', { name: 'Export conversation (Markdown)' }))
    expect(exportIt).toHaveBeenCalledExactlyOnceWith()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('lets long labels wrap instead of truncating them (wave 4 clipped text)', async () => {
    const { user, trigger } = setup()
    await user.click(trigger)
    const label = screen.getByText('Notify me when a conversation needs me')
    expect([label.className.includes('break-words'), label.className.includes('truncate')]).toStrictEqual([true, false])
  })

  // 5.35: rendered in place, the menu sat inside the panel header's `chrome-glass` stacking
  // context and the conversation pane took every pointer click (e2e assistant-notifications).
  it('renders the open menu outside the trigger\'s header, and a pointer click on an item selects it', async () => {
    const notify = vi.fn()
    const items: MoreMenuItem[] = [{ key: 'notify', label: 'Notify me', icon: null, onSelect: notify, checked: false }]
    render(<header className="chrome-glass"><MoreMenu label="More actions" items={items} /></header>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    const menu = screen.getByRole('menu')
    expect([menu.closest('header'), menu.parentElement]).toStrictEqual([null, document.body])
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Notify me' }))
    expect(notify).toHaveBeenCalledExactlyOnceWith()
  })

  it('stays inside the enclosing dialog, so an aria-modal assistant panel still contains it', async () => {
    const items = exportOnly()
    render(<div role="dialog" aria-modal="true" aria-label="Assistant"><header><MoreMenu label="More actions" items={items} /></header></div>)
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }))
    const menu = screen.getByRole('menu')
    expect([menu.parentElement, menu.closest('header')]).toStrictEqual([screen.getByRole('dialog', { name: 'Assistant' }), null])
  })

  it('Tab closes it and moves on from the trigger in the page\'s tab order', async () => {
    const items = exportOnly()
    render(<div><MoreMenu label="More actions" items={items} /><button type="button">Next control</button></div>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menuitem', { name: 'Export' })).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus()
  })

  it('a click outside the menu closes it', async () => {
    const items = exportOnly()
    render(<div><MoreMenu label="More actions" items={items} /><p>Elsewhere</p></div>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByText('Elsewhere'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
