import type { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { headlessEditor, markdownOf } from '../editor/headless-editor-fixtures'

/** Type `text` at the caret the way a keyboard does, so the input rules run. */
function type(editor: Editor, text: string) {
  for (const char of text) {
    const { from, to } = editor.state.selection
    const handled = editor.view.someProp('handleTextInput', (handle) => handle(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)))
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  }
}

describe('the callout', () => {
  it('is a note region named by its kind, from the labels the canvas passes', () => {
    const editor = headlessEditor('> [!WARNING]\n> Mind the gap.')
    const region = editor.view.dom.querySelector('[data-callout]')
    expect(region).toHaveAttribute('data-callout', 'warning')
    expect(region).toHaveAttribute('role', 'note')
    expect(region).toHaveAttribute('aria-label', 'Warning')
    expect(region).toHaveTextContent('Mind the gap.')
  })

  it('reads its kind back from pasted HTML, and an unknown kind as a note', () => {
    const tip = headlessEditor('<div data-callout="tip"><p>Short.</p></div>', 'html')
    expect(markdownOf(tip)).toBe('> [!TIP]\n> Short.')
    const unknown = headlessEditor('<div data-callout="shout"><p>Loud.</p></div>', 'html')
    expect(markdownOf(unknown)).toBe('> [!NOTE]\n> Loud.')
  })

  it('setCallout wraps a paragraph, then changes the kind of the callout it is in', () => {
    const editor = headlessEditor('Plan')
    editor.chain().setTextSelection(2).setCallout('important').run()
    expect(markdownOf(editor)).toBe('> [!IMPORTANT]\n> Plan')
    editor.chain().setTextSelection(3).setCallout('caution').run()
    expect(markdownOf(editor)).toBe('> [!CAUTION]\n> Plan')
    expect(editor.state.doc.childCount).toBe(1)
  })

  it.each([['[!tip] ', 'TIP'], ['[!WARNING] ', 'WARNING']])('typing %j at the start of a paragraph makes a callout', (marker, kind) => {
    const editor = headlessEditor('')
    editor.commands.setTextSelection(1)
    type(editor, marker)
    type(editor, 'Read me')
    expect(markdownOf(editor)).toBe(`> [!${kind}]\n> Read me`)
  })

  it('typing the marker at the start of a quote turns the quote into the callout (no quote around it)', () => {
    const editor = headlessEditor('')
    editor.commands.setTextSelection(1)
    type(editor, '> ')
    type(editor, '[!NOTE] ')
    type(editor, 'Inside')
    expect(markdownOf(editor)).toBe('> [!NOTE]\n> Inside')
    expect(editor.state.doc.child(0).type.name).toBe('callout')
  })

  it('leaves a marker it does not know as text', () => {
    const editor = headlessEditor('')
    editor.commands.setTextSelection(1)
    type(editor, '[!SHOUT] x')
    expect(editor.state.doc.child(0).type.name).toBe('paragraph')
    expect(editor.state.doc.textContent).toBe('[!SHOUT] x')
  })
})

describe('the raw-Markdown atoms', () => {
  it('shows Markdown the schema has no node for as a code-like block and writes it back as is', () => {
    const editor = headlessEditor('Intro\n\n[^1]: A footnote.')
    const raw = editor.view.dom.querySelector('pre[data-raw-markdown]')
    expect(raw).toHaveAttribute('data-raw-markdown', '[^1]: A footnote.')
    expect(raw).toHaveAttribute('translate', 'no')
    expect(raw?.querySelector('code')).toHaveTextContent('[^1]: A footnote.')
    expect(markdownOf(editor)).toBe('Intro\n\n[^1]: A footnote.')
  })

  it('shows inline raw Markdown as inline code and writes it back as is', () => {
    const editor = headlessEditor('Press <kbd>K</kbd> now')
    const raw = [...editor.view.dom.querySelectorAll('code[data-raw-markdown]')].map((element) => element.getAttribute('data-raw-markdown'))
    expect(raw).toStrictEqual(['<kbd>', '</kbd>'])
    expect(markdownOf(editor)).toBe('Press <kbd>K</kbd> now')
  })

  it('stays raw Markdown when its HTML is pasted back (copy and paste in the canvas), never a code block', () => {
    const block = headlessEditor('<pre data-raw-markdown="&lt;br&gt;"><code>shown</code></pre>', 'html')
    expect(block.state.doc.child(0).type.name).toBe('rawBlock')
    expect(markdownOf(block)).toBe('<br>')
    const inline = headlessEditor('<p>a <code data-raw-markdown="&lt;b&gt;">x</code> b</p>', 'html')
    expect(inline.state.doc.child(0).child(1).type.name).toBe('rawInline')
    expect(markdownOf(inline)).toBe('a <b> b')
  })
})
