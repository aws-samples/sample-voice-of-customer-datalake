/**
 * The editor schema: one node or mark for each Markdown construct convert.ts maps (and nothing it cannot write).
 * The extra attributes (`spread`, `checked`, `meta`, `align`, `ordered`) are never rendered; they carry what the
 * Markdown said so it is written back the same. Markdown shortcuts as you type come from the input rules: `# ` …
 * `###### `, `- ` / `* `, `1. `, `[ ] ` / `[x] ` (to-do), `> `, `[!NOTE] ` (callout; also TIP, IMPORTANT,
 * WARNING, CAUTION), ``` ``` ```, `---`, and `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``.
 */
import { type AnyExtension, Extension } from '@tiptap/core'
import Code from '@tiptap/extension-code'
import Image from '@tiptap/extension-image'
import { ListItem, TaskItem, TaskList } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import type { CalloutKind } from './callout'
import { isSafeHref } from './links'
import { Callout, RawBlock, RawInline } from './nodes'

export interface CanvasSchemaOptions {
  readonly placeholder: string
  readonly calloutLabels: Readonly<Record<CalloutKind, string>>
  readonly taskLabel: (checked: boolean) => string
  /** Class of an empty block (the placeholder's hook in the canvas CSS). */
  readonly emptyClass: string
}

const hidden = (fallback: unknown) => ({ default: fallback, rendered: false, keepOnSplit: false })

/** What Markdown says that the editor does not show, kept on the nodes it belongs to. */
const MarkdownAttributes = Extension.create({
  name: 'markdownAttributes',
  addGlobalAttributes() {
    return [
      { types: ['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem'], attributes: { spread: hidden(false) } },
      { types: ['listItem'], attributes: { checked: hidden(null) } },
      { types: ['taskList'], attributes: { ordered: hidden(false), start: hidden(null) } },
      { types: ['codeBlock'], attributes: { meta: hidden(null) } },
      { types: ['table'], attributes: { align: hidden(null) } },
    ]
  },
})

/** A list item may start with any block (`- # Heading`, `- > quote`), as in Markdown. */
const CanvasListItem = ListItem.extend({ content: 'block+' })
/**
 * The to-do's checkbox and its spoken label are chrome, not text: `data-anchor-skip` keeps them out of comment
 * anchors (components/DocumentComments/anchors.ts).
 */
const CanvasTaskItem = TaskItem.extend({
  content: 'block+',
  addNodeView() {
    const render = this.parent?.()
    if (!render) return null
    return (props) => {
      const view = render(props)
      const chrome = view.dom instanceof HTMLElement ? view.dom.querySelector(':scope > label') : null
      chrome?.setAttribute('data-anchor-skip', '')
      chrome?.setAttribute('contenteditable', 'false')
      return view
    }
  },
})

/** Inline code may sit inside bold, italic, strike and links (**`x`**), as Markdown allows. */
const CanvasCode = Code.extend({ excludes: 'code' })

/** A GFM cell holds one line of text: one paragraph, no blocks. */
const CanvasTableCell = TableCell.extend({ content: 'paragraph' })
const CanvasTableHeader = TableHeader.extend({ content: 'paragraph' })

export function canvasExtensions(options: CanvasSchemaOptions): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      listItem: false,
      code: false,
      underline: false,
      trailingNode: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        isAllowedUri: (url) => isSafeHref(url),
        shouldAutoLink: (url) => isSafeHref(url),
      },
    }),
    MarkdownAttributes,
    CanvasListItem,
    TaskList,
    CanvasTaskItem.configure({ nested: true, a11y: { checkboxLabel: (_node, checked) => options.taskLabel(checked) } }),
    CanvasCode,
    Table.configure({ resizable: false }),
    TableRow,
    CanvasTableHeader,
    CanvasTableCell,
    Image.configure({ inline: true, allowBase64: false }),
    Callout.configure({ labels: options.calloutLabels }),
    RawBlock,
    RawInline,
    Placeholder.configure({ placeholder: options.placeholder, emptyNodeClass: options.emptyClass }),
  ]
}
