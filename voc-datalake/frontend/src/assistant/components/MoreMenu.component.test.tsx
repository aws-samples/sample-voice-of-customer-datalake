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
})
