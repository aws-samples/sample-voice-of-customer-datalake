import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import BlockMenu from './BlockMenu'
import { blockPos, headlessEditor, markdownOf } from './headless-editor-fixtures'

const THREE = 'One\n\nTwo\n\nThree'

/** The block menu for the top-level block at `index` of `markdown`. */
function openMenu(markdown: string, index: number) {
  const editor = headlessEditor(markdown)
  const onClose = vi.fn()
  const view = render(<BlockMenu editor={editor} pos={blockPos(editor, index)} anchor={{ top: 40, left: 12 }} onClose={onClose} />)
  const menu = () => screen.getByRole('menu')
  const item = (name: string) => within(menu()).getByRole('menuitem', { name })
  return { editor, onClose, menu, item, ...view }
}

describe('BlockMenu', () => {
  it('sits at its anchor and offers the block actions', () => {
    const { menu, container } = openMenu(THREE, 1)
    expect(menu()).toHaveAccessibleName('Block actions')
    expect(within(menu()).getAllByRole('menuitem').map((item) => item.textContent)).toStrictEqual(['Move up', 'Move down', 'Turn into', 'Duplicate', 'Delete'])
    expect(container.firstElementChild).toHaveStyle({ top: '40px', left: '12px' })
  })

  it('cannot move the first block up', () => {
    expect(openMenu(THREE, 0).item('Move up')).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeEnabled()
  })

  it('cannot move the last block down', () => {
    const { item } = openMenu(THREE, 2)
    expect(item('Move down')).toBeDisabled()
    expect(item('Move up')).toBeEnabled()
  })

  it.each([
    ['Move up', 'Two\n\nOne\n\nThree'],
    ['Move down', 'One\n\nThree\n\nTwo'],
    ['Duplicate', 'One\n\nTwo\n\nTwo\n\nThree'],
    ['Delete', 'One\n\nThree'],
  ])('%s acts on its block, closes and gives the focus back to the text', async (action, expected) => {
    const user = userEvent.setup()
    const { editor, onClose, item } = openMenu(THREE, 1)
    await user.click(item(action))
    expect(markdownOf(editor)).toBe(expected)
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
    await waitFor(() => expect(editor.view.dom).toHaveFocus())
  })

  it('Turn into opens a submenu of blocks', async () => {
    const user = userEvent.setup()
    const { item, menu } = openMenu(THREE, 1)
    expect(item('Turn into')).toHaveAttribute('aria-haspopup', 'menu')
    await user.click(item('Turn into'))
    expect(menu()).toHaveAccessibleName('Turn into')
    expect(within(menu()).getAllByRole('menuitem').map((entry) => entry.textContent)).toStrictEqual(
      ['Back', 'Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Quote', 'Callout'],
    )
  })

  it('a block of the submenu turns the menu\'s block (not the one at the caret) and closes', async () => {
    const user = userEvent.setup()
    const { editor, onClose, item } = openMenu(THREE, 1)
    editor.commands.setTextSelection(2)
    await user.click(item('Turn into'))
    await user.click(item('Heading 2'))
    expect(markdownOf(editor)).toBe('One\n\n## Two\n\nThree')
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
  })

  it('Back and Escape in the submenu return to the actions', async () => {
    const user = userEvent.setup()
    const { onClose, item, menu } = openMenu(THREE, 1)
    await user.click(item('Turn into'))
    await user.click(item('Back'))
    expect(menu()).toHaveAccessibleName('Block actions')
    await user.click(item('Turn into'))
    fireEvent.keyDown(menu(), { key: 'Escape' })
    expect(menu()).toHaveAccessibleName('Block actions')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape on the actions closes the menu and gives the focus back to the text', async () => {
    const { editor, onClose, menu } = openMenu(THREE, 1)
    fireEvent.keyDown(menu(), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledExactlyOnceWith()
    await waitFor(() => expect(editor.view.dom).toHaveFocus())
  })

  it('cannot turn a block that holds no text (a divider)', () => {
    const { item } = openMenu('One\n\n---\n\nTwo', 1)
    expect(item('Turn into')).toBeDisabled()
    expect(item('Delete')).toBeEnabled()
  })
})
