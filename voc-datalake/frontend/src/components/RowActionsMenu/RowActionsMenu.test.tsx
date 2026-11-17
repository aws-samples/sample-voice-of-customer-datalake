/**
 * @fileoverview A row's ⋯ menu (7.52.00 C1): an icon button named for its item, a WAI-ARIA menu (the first item takes
 * the focus, the arrows move, Escape returns to the button), an item that cannot act stays with its reason as text and
 * does nothing, choosing one closes the menu and runs it, and separators are never first, last or doubled.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RowActionsMenu } from './RowActionsMenu'
import { tidyEntries } from './rowMenuEntries'
import type { RowMenuEntry } from './rowMenuEntries'

const action = (id: string, extra: Partial<Extract<RowMenuEntry, { kind: 'action' }>> = {}): RowMenuEntry =>
  ({ kind: 'action', id, label: id, onSelect: vi.fn(), ...extra })
const line = (id: string): RowMenuEntry => ({ kind: 'separator', id })

describe('RowActionsMenu', () => {
  it('opens a menu whose first item takes the focus, moves with the arrows, and returns to its button on Escape', async () => {
    render(<RowActionsMenu label="Actions for Scout" entries={[action('Open'), action('Rename…'), line('s'), action('Delete…', { danger: true })]} />)
    const button = screen.getByRole('button', { name: 'Actions for Scout' })
    await userEvent.click(button)
    const menu = screen.getByRole('menu', { name: 'Actions for Scout' })
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect([screen.queryByRole('menu'), document.activeElement]).toStrictEqual([null, button])
  })

  it('runs a chosen item once closed, and keeps one that cannot act, with its reason, doing nothing', async () => {
    const archive = vi.fn()
    const open = vi.fn()
    render(<RowActionsMenu label="Actions for Bug flow" entries={[action('Open', { onSelect: open }),
      action('Archive…', { onSelect: archive, reason: 'Used by Bug fixer' })]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Bug flow' }))
    const blocked = screen.getByRole('menuitem', { name: /Archive…/ })
    expect([blocked.getAttribute('aria-disabled'), blocked.textContent]).toStrictEqual(['true', 'Archive…Used by Bug fixer'])
    await userEvent.click(blocked)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open' }))
    expect([archive.mock.calls.length, open.mock.calls.length, screen.queryByRole('menu')]).toStrictEqual([0, 1, null])
  })

  it('is a text button with a face, named by its words', () => {
    render(<RowActionsMenu label="Run another flow" face={<>Run another flow</>} className="btn btn-secondary btn-sm" entries={[action('A')]} />)
    expect(screen.getByRole('button', { name: 'Run another flow' })).toHaveClass('btn-secondary')
  })
})

describe('tidyEntries', () => {
  it('drops a separator first, last or doubled, and a group left empty', () => {
    expect(tidyEntries([line('a'), action('x'), line('b'), line('c'), action('y'), line('d')]).map((entry) => entry.id))
      .toStrictEqual(['x', 'c', 'y'])
    expect(tidyEntries([line('a')])).toStrictEqual([])
  })
})
