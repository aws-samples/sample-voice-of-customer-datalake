import type { Editor } from '@tiptap/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { indexText } from '../../DocumentComments/anchors'
import CanvasEditor, { type CanvasEditorHandle, type CanvasEditorProps } from './CanvasEditor'
import * as noCollaboration from './noCollaboration'

// ProseMirror measures the DOM (coordsAtPos, scrollIntoView); jsdom has no layout, so every box is empty.
beforeAll(() => {
  const empty = () => new DOMRect(0, 0, 0, 0)
  Range.prototype.getBoundingClientRect = empty
  Range.prototype.getClientRects = () => document.createElement('div').getClientRects()
  Element.prototype.scrollIntoView = vi.fn()
  document.elementFromPoint = () => null
})

const DEFAULT_MARKDOWN = '# Title\n\nFirst paragraph.'

function renderCanvas(props: Partial<CanvasEditorProps> = {}) {
  const handle = createRef<CanvasEditorHandle>()
  const onChange = vi.fn<(markdown: string) => void>()
  const onOutlineChange = vi.fn()
  const view = render(
    <CanvasEditor markdown={DEFAULT_MARKDOWN} editable ariaLabel="Launch plan" onChange={onChange} onOutlineChange={onOutlineChange} handleRef={handle} {...props} />,
  )
  return { handle, onChange, onOutlineChange, ...view }
}

const isEditor = (value: unknown): value is Editor =>
  typeof value === 'object' && value !== null && 'commands' in value && 'state' in value

/** TipTap puts the editor on its DOM node; the specs drive it as a user's edits would. */
async function editorOf(handle: React.RefObject<CanvasEditorHandle | null>): Promise<Editor> {
  const root = await waitFor(() => {
    const dom = handle.current?.root()
    if (!dom) throw new Error('editor not mounted yet')
    return dom
  })
  const editor: unknown = Reflect.get(root, 'editor')
  if (!isEditor(editor)) throw new Error('no editor on the DOM')
  return editor
}

const textEnd = (editor: Editor) => editor.state.doc.content.size - 1

/** Render the canvas, then make an edit or a selection in it as the user would. */
async function canvasAfter(markdown: string, change: (editor: Editor) => unknown, props: Partial<CanvasEditorProps> = {}) {
  const rendered = renderCanvas({ ...props, markdown })
  const editor = await editorOf(rendered.handle)
  act(() => {
    change(editor)
  })
  return { ...rendered, editor }
}

describe('CanvasEditor', () => {
  it('runs the drag handle on the stand-in for Yjs, as the dev server and the build do (canvasResolve.ts)', async () => {
    const { handle, container } = renderCanvas()
    await editorOf(handle)
    // The handle is mounted (hidden until a block is hovered).
    expect(container.querySelector('.canvas-handle__grip')).toHaveAttribute('aria-label', 'Drag to move the block, or click for its menu')
    // Yjs marks the global object when it loads; the stand-in never loads it.
    expect(Reflect.get(globalThis, '__ $YJS$ __')).toBeUndefined()
    const [collaboration, yTiptap] = await Promise.all([import('@tiptap/extension-collaboration'), import('@tiptap/y-tiptap')])
    expect(collaboration).toBe(noCollaboration)
    expect(yTiptap).toBe(noCollaboration)
  })

  it('shows the Markdown as a labelled, editable text box', async () => {
    const { handle } = renderCanvas()
    await editorOf(handle)
    const box = screen.getByRole('textbox', { name: 'Launch plan' })
    expect(box).toHaveAttribute('contenteditable', 'true')
    expect(within(box).getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
  })

  it('returns the stored text byte for byte while nothing changed, and fires no onChange', async () => {
    const markdown = '# Title\n_One sentence._\n\n- Goal: \n'
    const { handle, onChange } = renderCanvas({ markdown })
    await editorOf(handle)
    expect(handle.current?.getMarkdown()).toBe(markdown)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('serialises a change to Markdown and reports it', async () => {
    const { handle, onChange } = renderCanvas()
    const editor = await editorOf(handle)
    act(() => {
      editor.chain().setTextSelection(textEnd(editor)).insertContent(' More [FR:fr_1].').run()
    })
    const markdown = handle.current?.getMarkdown()
    // Stored without a trailing newline, saved without one.
    expect(markdown).toBe('# Title\n\nFirst paragraph. More [FR:fr_1].')
    expect(onChange).toHaveBeenLastCalledWith(markdown)
  })

  it('reports the change after a short pause without being asked', async () => {
    const { handle, onChange } = renderCanvas()
    const editor = await editorOf(handle)
    act(() => {
      editor.chain().setTextSelection(textEnd(editor)).insertContent('!').run()
    })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('# Title\n\nFirst paragraph.!'))
  })

  it('never replaces a change typed inside its pause when the host sends other content: it is reported instead', async () => {
    const { handle, onChange, rerender } = renderCanvas()
    const editor = await editorOf(handle)
    act(() => {
      editor.chain().setTextSelection(textEnd(editor)).insertContent(' mine').run()
    })

    rerender(<CanvasEditor markdown="theirs" editable ariaLabel="Launch plan" onChange={onChange} handleRef={handle} />)

    expect(onChange).toHaveBeenLastCalledWith('# Title\n\nFirst paragraph. mine')
    expect(handle.current?.getMarkdown()).toBe('# Title\n\nFirst paragraph. mine')
  })

  it('replaces the content with setMarkdown without firing onChange', async () => {
    const { handle, onChange, onOutlineChange } = renderCanvas()
    await editorOf(handle)
    act(() => handle.current?.setMarkdown('## Latest\n\nFrom the server.'))
    expect(handle.current?.getMarkdown()).toBe('## Latest\n\nFrom the server.')
    expect(onChange).not.toHaveBeenCalled()
    expect(onOutlineChange).toHaveBeenLastCalledWith([{ id: 'h-latest', level: 2, text: 'Latest' }])
  })

  it('gives each heading a stable id and reports the outline (h1-h3: an h4 or deeper is not in it)', async () => {
    const { handle, onOutlineChange } = renderCanvas({ markdown: '# Plan\n\n## Risks\n\n## Risks\n\n#### Fine print\n\n##### Deep\n' })
    await editorOf(handle)
    await waitFor(() => expect(onOutlineChange).toHaveBeenLastCalledWith([
      { id: 'h-plan', level: 1, text: 'Plan' },
      { id: 'h-risks', level: 2, text: 'Risks' },
      { id: 'h-risks-1', level: 2, text: 'Risks' },
    ]))
    const ids = screen.getAllByRole('heading').map((heading) => heading.id)
    expect(ids).toStrictEqual(['h-plan', 'h-risks', 'h-risks-1', 'h-fine-print', 'h-deep'])
  })

  it('is a read-only canvas when not editable: nothing is contenteditable, links stay links', async () => {
    const { handle, container } = renderCanvas({ editable: false, markdown: 'See [the request](/feature-requests?request=fr_1).' })
    await editorOf(handle)
    expect(container.querySelector('[contenteditable="true"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'the request' })).toHaveAttribute('href', '/feature-requests?request=fr_1')
  })

  it('never renders a javascript: link from stored Markdown', async () => {
    const { handle, container } = renderCanvas({ editable: false, markdown: '[x](javascript:alert(1))' })
    await editorOf(handle)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('')
  })

  it.each([['//evil.example/x'], ['\\\\evil.example'], ['/\\evil.example']])(
    'never renders a link to another host written without a scheme (%s)', async (href) => {
      const { handle, container } = renderCanvas({ editable: false, markdown: `[x](${href})` })
      await editorOf(handle)
      expect(container.querySelector('a')?.getAttribute('href')).toBe('')
    })

  it('drops a pasted link to //another-host and refuses to set one', async () => {
    const { handle, editor } = await canvasAfter('Intro', (current) => current.chain().setTextSelection(textEnd(current)).insertContent(' ').run())
    const html = '<a href="//evil.example/x">there</a>'
    fireEvent.paste(handle.current?.root() ?? document.body, {
      clipboardData: { types: ['text/html'], getData: (type: string) => (type === 'text/html' ? html : ''), files: [] },
    })
    expect(handle.current?.getMarkdown()).toBe('Intro there')
    act(() => {
      editor.chain().setTextSelection({ from: 1, to: 6 }).setLink({ href: '//evil.example/x' }).run()
    })
    expect(handle.current?.getMarkdown()).toBe('Intro there')
    act(() => {
      editor.chain().setTextSelection({ from: 1, to: 6 }).setLink({ href: '/projects/p1' }).run()
    })
    expect(handle.current?.getMarkdown()).toBe('[Intro](/projects/p1) there')
  })
})

describe('the image dialog', () => {
  async function openImageDialog() {
    const user = userEvent.setup()
    const { handle } = await canvasAfter('', (editor) => editor.commands.insertContent('/image'))
    await screen.findByRole('listbox', { name: 'Blocks' })
    fireEvent.keyDown(handle.current?.root() ?? document.body, { key: 'Enter' })
    const dialog = await screen.findByRole('dialog', { name: 'Insert an image' })
    await user.type(within(dialog).getByLabelText('Alt text'), 'A chart')
    return { user, handle, dialog }
  }

  it.each([['//evil.example/x.png'], ['\\\\evil.example\\x.png'], ['javascript:alert(1)']])('refuses the address %s', async (src) => {
    const { user, handle, dialog } = await openImageDialog()
    await user.type(within(dialog).getByLabelText('Image address'), src)
    await user.click(within(dialog).getByRole('button', { name: 'Insert' }))
    expect(within(dialog).getByText(/Use a web address/)).toBeVisible()
    expect(handle.current?.getMarkdown()).not.toContain('![')
  })

  it('inserts an image from a path in the app', async () => {
    const { user, handle, dialog } = await openImageDialog()
    await user.type(within(dialog).getByLabelText('Image address'), '/img/chart.png')
    await user.click(within(dialog).getByRole('button', { name: 'Insert' }))
    expect(handle.current?.getMarkdown()).toContain('![A chart](/img/chart.png)')
  })
})

describe('the "/" block menu', () => {
  it('opens on "/" at an empty paragraph, filters, and inserts a heading with Enter', async () => {
    const { handle } = renderCanvas({ markdown: 'Intro' })
    const editor = await editorOf(handle)
    act(() => {
      editor.chain().setTextSelection(textEnd(editor)).splitBlock().insertContent('/head').run()
    })
    const list = await screen.findByRole('listbox', { name: 'Blocks' })
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['Heading 1', 'Heading 2', 'Heading 3'])
    const root = handle.current?.root()
    fireEvent.keyDown(root ?? document.body, { key: 'ArrowDown' })
    await waitFor(() => expect(within(list).getByRole('option', { name: 'Heading 2' })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.keyDown(root ?? document.body, { key: 'Enter' })
    act(() => {
      editor.commands.insertContent('Next steps')
    })
    expect(handle.current?.getMarkdown()).toBe('Intro\n\n## Next steps')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('points the text box at the active option (the combobox pattern)', async () => {
    const { handle } = await canvasAfter('', (editor) => editor.commands.insertContent('/'))
    const list = await screen.findByRole('listbox', { name: 'Blocks' })
    const root = handle.current?.root()
    expect(root).toHaveAttribute('aria-activedescendant', within(list).getAllByRole('option')[0]?.id)
    expect(root).toHaveAttribute('aria-controls', list.id)
    expect(within(list).getAllByRole('option')).toHaveLength(13)
  })

  it('closes with Escape and leaves the "/" as text', async () => {
    const { handle } = await canvasAfter('', (editor) => editor.commands.insertContent('/'))
    await screen.findByRole('listbox')
    fireEvent.keyDown(handle.current?.root() ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(handle.current?.getMarkdown()).toBe('/')
  })

  it('does not open in the middle of a word', async () => {
    const { handle } = renderCanvas({ markdown: 'and' })
    const editor = await editorOf(handle)
    act(() => {
      editor.chain().setTextSelection(textEnd(editor)).insertContent('/or').run()
    })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('the format bar and the link editor', () => {
  it('bolds the selected text', async () => {
    const user = userEvent.setup()
    const { handle } = await canvasAfter('Make this bold', (editor) => editor.commands.setTextSelection({ from: 11, to: 15 }))
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    await user.click(within(bar).getByRole('button', { name: 'Bold' }))
    expect(handle.current?.getMarkdown()).toBe('Make this **bold**')
  })

  it('offers only Comment in a read-only canvas, and calls the host', async () => {
    const user = userEvent.setup()
    const onCommentSelection = vi.fn()
    const { handle } = renderCanvas({ editable: false, markdown: 'Quote me', onCommentSelection })
    const editor = await editorOf(handle)
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 })
    })
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    expect(within(bar).getAllByRole('button').map((button) => button.textContent)).toStrictEqual(['Comment'])
    await user.click(within(bar).getByRole('button', { name: 'Comment' }))
    expect(onCommentSelection).toHaveBeenCalledExactlyOnceWith()
  })

  it('closes when the host clears the selection a comment took (clearSelection)', async () => {
    const { handle, editor } = await canvasAfter('Quote me here', (current) => current.commands.setTextSelection({ from: 1, to: 6 }),
      { onCommentSelection: vi.fn() })
    expect(await screen.findByRole('toolbar', { name: 'Text formatting' })).toBeVisible()

    act(() => handle.current?.clearSelection())

    expect({ from: editor.state.selection.from, to: editor.state.selection.to }).toStrictEqual({ from: 6, to: 6 })
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Text formatting' })).toBeNull())
  })

  it.each([['Italic', 'Make this *bold*'], ['Strikethrough', 'Make this ~~bold~~'], ['Inline code', 'Make this `bold`']])(
    '%s marks the selected text and shows the button pressed', async (name, expected) => {
      const user = userEvent.setup()
      const { handle } = await canvasAfter('Make this bold', (editor) => editor.commands.setTextSelection({ from: 11, to: 15 }))
      const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
      const button = within(bar).getByRole('button', { name })
      expect(button).toHaveAttribute('aria-pressed', 'false')
      await user.click(button)
      expect(handle.current?.getMarkdown()).toBe(expected)
      await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
    })

  it('offers the marks, Link and Turn into in an editable canvas (no Comment unless the host takes comments)', async () => {
    await canvasAfter('Make this bold', (editor) => editor.commands.setTextSelection({ from: 11, to: 15 }))
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    expect(within(bar).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent))
      .toStrictEqual(['Bold', 'Italic', 'Strikethrough', 'Inline code', 'Link', 'Turn into'])
  })

  it('opens the link editor from its Link button', async () => {
    const user = userEvent.setup()
    await canvasAfter('Read the docs', (editor) => editor.commands.setTextSelection({ from: 10, to: 14 }))
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    await user.click(within(bar).getByRole('button', { name: 'Link' }))
    expect(await screen.findByRole('dialog', { name: 'Link' })).toBeVisible()
  })

  it('turns the block into another from its Turn into menu', async () => {
    const user = userEvent.setup()
    const { handle } = await canvasAfter('Intro\n\nMake this a heading', (editor) => editor.commands.setTextSelection({ from: 8, to: 12 }))
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    const turnInto = within(bar).getByRole('button', { name: 'Turn into' })
    expect(turnInto).toHaveAttribute('aria-expanded', 'false')
    await user.click(turnInto)
    expect(turnInto).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'Turn into' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Heading 1' }))
    expect(handle.current?.getMarkdown()).toBe('Intro\n\n# Make this a heading')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes its Turn into menu with Escape, keeping the bar', async () => {
    const user = userEvent.setup()
    await canvasAfter('Make this bold', (editor) => editor.commands.setTextSelection({ from: 11, to: 15 }))
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    await user.click(within(bar).getByRole('button', { name: 'Turn into' }))
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Turn into' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(bar).toBeVisible()
  })

  it('is one tab stop: focus lands on its first button, the arrows move along it, Alt+F10 reaches it from the text', async () => {
    const { handle } = await canvasAfter('Make this bold', (editor) => editor.commands.setTextSelection({ from: 11, to: 15 }))
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    const buttons = within(bar).getAllByRole('button')
    const focused = () => buttons.findIndex((button) => button === document.activeElement)
    expect([bar, ...buttons].map((element) => element.getAttribute('tabindex'))).toStrictEqual(['0', ...buttons.map(() => '-1')])
    act(() => bar.focus())
    const visited = [focused(), ...['ArrowRight', 'End', 'ArrowRight', 'ArrowLeft', 'Home'].map((key) => {
      fireEvent.keyDown(bar, { key })
      return focused()
    })]
    const last = buttons.length - 1
    expect(visited).toStrictEqual([0, 1, last, 0, last, 0])
    act(() => handle.current?.focus())
    fireEvent.keyDown(handle.current?.root() ?? document.body, { key: 'F10', altKey: true })
    expect(buttons[0]).toHaveFocus()
  })

  it('hides on Escape and gives the focus back to the text until the selection changes', async () => {
    const { handle, editor } = await canvasAfter('Make this bold', (current) => current.commands.setTextSelection({ from: 11, to: 15 }))
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    act(() => bar.focus())
    fireEvent.keyDown(bar, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Text formatting' })).toBeNull())
    expect(handle.current?.root()).toHaveFocus()
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 })
    })
    expect(await screen.findByRole('toolbar', { name: 'Text formatting' })).toBeVisible()
  })

  it('hides for a selection without text (only spaces)', async () => {
    const { editor } = await canvasAfter('a   b', (current) => current.commands.setTextSelection({ from: 1, to: 6 }))
    expect(await screen.findByRole('toolbar', { name: 'Text formatting' })).toBeVisible()
    act(() => {
      editor.commands.setTextSelection({ from: 2, to: 5 })
    })
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Text formatting' })).toBeNull())
  })

  it('refuses a javascript: link and accepts an https one (Mod+K)', async () => {
    const user = userEvent.setup()
    const { handle } = await canvasAfter('Read the docs', (editor) => editor.commands.setTextSelection({ from: 10, to: 14 }))
    fireEvent.keyDown(handle.current?.root() ?? document.body, { key: 'k', ctrlKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Link' })
    const input = within(dialog).getByLabelText('Link address')
    await user.type(input, 'javascript:alert(1)')
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Use a web address')
    expect(handle.current?.getMarkdown()).toBe('Read the docs')
    await user.clear(input)
    await user.type(input, 'example.com/docs')
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(handle.current?.getMarkdown()).toBe('Read the [docs](https://example.com/docs)')
  })
})

describe('moving blocks with the keyboard', () => {
  it('Alt+Shift+ArrowDown moves the current block down', async () => {
    const { handle } = await canvasAfter('One\n\nTwo\n\nThree', (editor) => editor.commands.setTextSelection(2))
    fireEvent.keyDown(handle.current?.root() ?? document.body, { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(handle.current?.getMarkdown()).toBe('Two\n\nOne\n\nThree')
  })

  it('Alt+Shift+M opens the block menu; Delete removes the block', async () => {
    const user = userEvent.setup()
    const { handle } = await canvasAfter('One\n\nTwo', (editor) => editor.commands.setTextSelection(2))
    fireEvent.keyDown(handle.current?.root() ?? document.body, { key: 'm', code: 'KeyM', altKey: true, shiftKey: true })
    const menu = await screen.findByRole('menu', { name: 'Block actions' })
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    expect(handle.current?.getMarkdown()).toBe('Two')
  })
})

describe('what the other parts of the page rely on', () => {
  const OUTLINED = '# Plan\n\nIntro.\n\n## Risks\n\nSome risks.\n'

  it('scrollToHeading scrolls smoothly and puts the caret at the start of the heading', async () => {
    const { handle } = renderCanvas({ markdown: OUTLINED })
    const editor = await editorOf(handle)
    const scroll = vi.mocked(Element.prototype.scrollIntoView)
    scroll.mockClear()
    act(() => handle.current?.scrollToHeading('h-risks'))
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'start', behavior: 'smooth' })
    expect(scroll.mock.contexts[0]).toBe(screen.getByRole('heading', { name: 'Risks' }))
    const { $from } = editor.state.selection
    expect({ block: $from.parent.type.name, text: $from.parent.textContent, offset: $from.parentOffset })
      .toStrictEqual({ block: 'heading', text: 'Risks', offset: 0 })
    await waitFor(() => expect(handle.current?.root()).toHaveFocus())
  })

  it('scrollToHeading jumps without animation when the reader prefers reduced motion', async () => {
    const reduced = Object.assign(window.matchMedia('(prefers-reduced-motion: reduce)'), { matches: true })
    vi.stubGlobal('matchMedia', () => reduced)
    try {
      const { handle } = renderCanvas({ markdown: OUTLINED })
      await editorOf(handle)
      const scroll = vi.mocked(Element.prototype.scrollIntoView)
      scroll.mockClear()
      act(() => handle.current?.scrollToHeading('h-risks'))
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'start', behavior: 'auto' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('scrollToHeading focuses the heading itself in a read-only canvas', async () => {
    const { handle } = renderCanvas({ markdown: OUTLINED, editable: false })
    await editorOf(handle)
    act(() => handle.current?.scrollToHeading('h-risks'))
    const heading = screen.getByRole('heading', { name: 'Risks' })
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(heading).toHaveFocus()
  })

  it('reports the outline once on load, then only when the headings change', async () => {
    const { handle, onOutlineChange } = renderCanvas({ markdown: OUTLINED })
    const editor = await editorOf(handle)
    expect(onOutlineChange).toHaveBeenCalledExactlyOnceWith([
      { id: 'h-plan', level: 1, text: 'Plan' },
      { id: 'h-risks', level: 2, text: 'Risks' },
    ])
    act(() => {
      editor.chain().setTextSelection(textEnd(editor)).insertContent(' More.').run()
    })
    act(() => {
      editor.commands.insertContent(' Again.')
    })
    expect(onOutlineChange).toHaveBeenCalledTimes(1)
    act(() => {
      editor.chain().setTextSelection(2).insertContent('X').run()
    })
    expect(onOutlineChange).toHaveBeenCalledTimes(2)
    expect(onOutlineChange).toHaveBeenLastCalledWith([
      { id: 'h-pxlan', level: 1, text: 'PXlan' },
      { id: 'h-risks', level: 2, text: 'Risks' },
    ])
  })

  it('keeps its own chrome out of the comment anchors: only the prose is indexed', async () => {
    const markdown = '> [!WARNING]\n> Mind the gap.\n\n```ts\nconst a = 1\n```\n\n- [ ] Ship it\n- [x] Test it\n'
    const { handle } = renderCanvas({ markdown, editable: false })
    const root = (await editorOf(handle)).view.dom
    expect(indexText(root).text).toBe('Mind the gap. const a = 1 Ship it Test it')
    const chrome = [...root.querySelectorAll('[data-anchor-skip]')]
    expect(chrome).toHaveLength(2)
    chrome.forEach((element) => expect(element).toHaveAttribute('contenteditable', 'false'))
  })

  it('keeps the text selection when a format bar button is pressed', async () => {
    const onCommentSelection = vi.fn()
    await canvasAfter('Quote me here', (editor) => editor.commands.setTextSelection({ from: 1, to: 6 }), { onCommentSelection })
    const bar = await screen.findByRole('toolbar', { name: 'Text formatting' })
    expect(within(bar).getByRole('button', { name: 'Comment' })).toBeInTheDocument()
    within(bar).getAllByRole('button').forEach((button) => {
      // fireEvent returns false when a handler called preventDefault.
      expect(fireEvent.mouseDown(button)).toBe(false)
    })
  })

  it('lets Ctrl+Alt+M and Cmd+Alt+M (the comment shortcut) through to the page', async () => {
    const onParentKey = vi.fn<(code: string, prevented: boolean) => void>()
    const handle = createRef<CanvasEditorHandle>()
    const listener = (event: KeyboardEvent) => onParentKey(event.code, event.defaultPrevented)
    document.addEventListener('keydown', listener)
    try {
      render(<CanvasEditor markdown="Quote me" editable ariaLabel="Doc" handleRef={handle} />)
      const editor = await editorOf(handle)
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 6 })
      })
      const root = handle.current?.root() ?? document.body
      fireEvent.keyDown(root, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })
      fireEvent.keyDown(root, { key: 'µ', code: 'KeyM', metaKey: true, altKey: true })
      expect(onParentKey.mock.calls).toStrictEqual([['KeyM', false], ['KeyM', false]])
      expect(handle.current?.getMarkdown()).toBe('Quote me')
    } finally {
      document.removeEventListener('keydown', listener)
    }
  })

  it('undo back to the stored text reports the stored text byte for byte (the page is clean again)', async () => {
    const markdown = '# Title\n_One sentence._\n\n- Goal: \n'
    const { handle, onChange } = renderCanvas({ markdown })
    const editor = await editorOf(handle)
    act(() => handle.current?.setMarkdown(markdown))
    expect(onChange).not.toHaveBeenCalled()
    act(() => {
      editor.chain().setTextSelection(3).insertContent('X').run()
    })
    const edited = handle.current?.getMarkdown()
    expect(edited).not.toBe(markdown)
    act(() => {
      editor.commands.undo()
    })
    expect(handle.current?.getMarkdown()).toBe(markdown)
    expect(onChange.mock.calls).toStrictEqual([[edited], [markdown]])
  })
})
