/** The canvas's own nodes: the callout (a GFM alert) and the raw-Markdown atoms (block and inline). */
import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { type CalloutKind, isCalloutKind } from './callout'

interface CalloutOptions {
  /** The callout's accessible name per kind ("Note", "Warning" …), already translated. */
  readonly labels: Readonly<Record<CalloutKind, string>>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block in a callout of this kind (or change the kind of the callout it is in). */
      setCallout: (kind: CalloutKind) => ReturnType
    }
  }
}

/** `[!NOTE] ` (TIP, IMPORTANT, WARNING, CAUTION; any case) typed at the start of a paragraph or a quote. */
const CALLOUT_INPUT = /^\[!(note|tip|important|warning|caution)\]\s$/i

export const Callout = Node.create<CalloutOptions>({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addOptions() {
    return { labels: { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' } }
  },

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element) => {
          const kind = element.getAttribute('data-callout')
          return isCalloutKind(kind) ? kind : 'note'
        },
        renderHTML: () => ({}),
      },
      // The marker had a paragraph of its own (`> [!NOTE]` then a blank `>` line): kept to write it back the same.
      split: { default: false, rendered: false },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const attr: unknown = node.attrs.kind
    const kind = isCalloutKind(attr) ? attr : 'note'
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': kind, role: 'note', 'aria-label': this.options.labels[kind] }), 0]
  },

  addCommands() {
    return {
      setCallout: (kind) => ({ commands, editor }) =>
        editor.isActive('callout') ? commands.updateAttributes('callout', { kind }) : commands.wrapIn(this.name, { kind }),
    }
  },

  addInputRules() {
    return [
      new InputRule({
        find: CALLOUT_INPUT,
        handler: ({ chain, range, match }) => {
          const kind = match[1]?.toLowerCase()
          if (!isCalloutKind(kind)) return
          chain().deleteRange(range).lift('blockquote').wrapIn(this.name, { kind }).run()
        },
      }),
    ]
  },
})

function rawSource(element: HTMLElement): string {
  return element.getAttribute('data-raw-markdown') ?? element.textContent
}

/**
 * What both raw-Markdown atoms share: the `source` attribute, read back from the element that showed it. Their
 * parse rule outranks the code block's `pre` and the code mark's `code` (priority 50), so a raw block copied and
 * pasted in the canvas stays raw Markdown instead of turning into a fenced code block.
 */
const rawAtom = (tag: 'pre' | 'code') => ({
  atom: true,
  selectable: true,
  addAttributes: () => ({ source: { default: '', parseHTML: rawSource, renderHTML: () => ({}) } }),
  parseHTML: () => [{ tag: `${tag}[data-raw-markdown]`, priority: 60 }],
})

/** Markdown the schema has no node for (raw HTML, footnotes, definitions …), shown and written back as is. */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  draggable: true,
  ...rawAtom('pre'),
  renderHTML({ node }) {
    const source = String(node.attrs.source)
    return ['pre', { 'data-raw-markdown': source, class: 'canvas-raw', translate: 'no' }, ['code', {}, source]]
  },
})

/** Inline raw Markdown: an HTML tag, a footnote or reference link, kept as its source. */
export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  ...rawAtom('code'),
  renderHTML({ node }) {
    const source = String(node.attrs.source)
    return ['code', { 'data-raw-markdown': source, class: 'canvas-raw-inline', translate: 'no' }, source]
  },
})
