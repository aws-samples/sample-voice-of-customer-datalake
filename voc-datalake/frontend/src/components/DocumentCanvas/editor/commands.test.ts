/**
 * The canvas's commands as the page's menus run them (commands.ts), on a real headless editor: the marks and blocks
 * change the text a save would store, undo / redo walk the editor's own history, Link and Image open the popovers
 * the keys and the "/" menu open, and nothing runs on a read-only canvas.
 */
import { describe, expect, it, vi } from 'vitest'
import { canRunCommand, runCommand } from './commands'
import { CanvasController } from './controller'
import { headlessEditor, markdownOf } from './headless-editor-fixtures'

function selectAll(editor: ReturnType<typeof headlessEditor>) {
  editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })
}

describe('runCommand', () => {
  it('toggles a mark on the selection and turns the block into a heading', () => {
    const editor = headlessEditor('Launch plan')
    const controller = new CanvasController()
    selectAll(editor)
    expect(runCommand(editor, controller, 'bold')).toBe(true)
    expect(markdownOf(editor)).toBe('**Launch plan**')
    runCommand(editor, controller, 'heading2')
    expect(markdownOf(editor)).toBe('## **Launch plan**')
  })

  it('makes a list, a quote and a code block of the current block', () => {
    const controller = new CanvasController()
    const results = (['bulletList', 'blockquote', 'codeBlock'] as const).map((command) => {
      const editor = headlessEditor('One')
      editor.commands.setTextSelection(2)
      runCommand(editor, controller, command)
      return markdownOf(editor)
    })
    expect(results).toStrictEqual(['- One', '> One', '```\nOne\n```'])
  })

  it('inserts a table and a divider at the caret', () => {
    const controller = new CanvasController()
    const editor = headlessEditor('One')
    editor.commands.setTextSelection(4)
    runCommand(editor, controller, 'divider')
    expect(markdownOf(editor)).toContain('---')
    runCommand(editor, controller, 'table')
    expect(editor.getJSON().content.map((node) => node.type)).toContain('table')
  })

  it('undoes and redoes through the editor\'s history, and says when there is nothing to undo', () => {
    const controller = new CanvasController()
    const editor = headlessEditor('One')
    expect(canRunCommand(editor, 'undo')).toBe(false)
    selectAll(editor)
    runCommand(editor, controller, 'italic')
    expect([canRunCommand(editor, 'undo'), canRunCommand(editor, 'redo')]).toStrictEqual([true, false])
    runCommand(editor, controller, 'undo')
    expect([markdownOf(editor), canRunCommand(editor, 'redo')]).toStrictEqual(['One', true])
    runCommand(editor, controller, 'redo')
    expect(markdownOf(editor)).toBe('*One*')
  })

  it('opens the link and image popovers through the controller', () => {
    const controller = new CanvasController()
    const link = vi.fn()
    const image = vi.fn()
    controller.setOpenLink(link)
    controller.setOpenImage(image)
    const editor = headlessEditor('One')
    runCommand(editor, controller, 'link')
    runCommand(editor, controller, 'image')
    expect([link.mock.calls.length, image.mock.calls.length]).toStrictEqual([1, 1])
  })

  it('keeps an image asked for before its dialog has loaded, and opens it once it registers', () => {
    const controller = new CanvasController()
    runCommand(headlessEditor('One'), controller, 'image')
    const image = vi.fn()
    controller.setOpenImage(image)
    expect(image).toHaveBeenCalledTimes(1)
  })

  it('runs nothing on a read-only canvas, or without an editor', () => {
    const controller = new CanvasController()
    const editor = headlessEditor('One')
    editor.setEditable(false)
    selectAll(editor)
    expect([runCommand(editor, controller, 'bold'), canRunCommand(editor, 'bold'), runCommand(null, controller, 'bold')])
      .toStrictEqual([false, false, false])
    expect(markdownOf(editor)).toBe('One')
  })
})
