/** The blocks the "/" menu inserts and "Turn into" converts to, with their commands. */
import type { ChainedCommands, Editor } from '@tiptap/core'
import {
  CodeXml, Heading1, Heading2, Heading3, ImageIcon, List, ListOrdered, ListTodo, type LucideIcon, Megaphone,
  Minus, Pilcrow, Quote, Table2,
} from 'lucide-react'

export type BlockId =
  | 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'bulletList' | 'orderedList' | 'taskList'
  | 'blockquote' | 'callout' | 'codeBlock' | 'table' | 'divider' | 'image'

export interface BlockChoice {
  readonly id: BlockId
  readonly icon: LucideIcon
  /** Extra words the "/" filter matches (English and Markdown names), beside the translated label. */
  readonly aliases: string
}

export const SLASH_BLOCKS: readonly BlockChoice[] = [
  { id: 'paragraph', icon: Pilcrow, aliases: 'text paragraph p' },
  { id: 'heading1', icon: Heading1, aliases: 'h1 # title heading' },
  { id: 'heading2', icon: Heading2, aliases: 'h2 ## heading' },
  { id: 'heading3', icon: Heading3, aliases: 'h3 ### heading' },
  { id: 'bulletList', icon: List, aliases: 'ul bullet list -' },
  { id: 'orderedList', icon: ListOrdered, aliases: 'ol numbered ordered list 1.' },
  { id: 'taskList', icon: ListTodo, aliases: 'todo task checkbox [ ]' },
  { id: 'blockquote', icon: Quote, aliases: 'quote blockquote >' },
  { id: 'callout', icon: Megaphone, aliases: 'callout note tip warning alert' },
  { id: 'codeBlock', icon: CodeXml, aliases: 'code fence ```' },
  { id: 'table', icon: Table2, aliases: 'table grid' },
  { id: 'divider', icon: Minus, aliases: 'divider rule hr ---' },
  { id: 'image', icon: ImageIcon, aliases: 'image picture img' },
]

const TURN_INTO_IDS: readonly BlockId[] = ['paragraph', 'heading1', 'heading2', 'heading3', 'blockquote', 'callout']
export const TURN_INTO_BLOCKS = SLASH_BLOCKS.filter((block) => TURN_INTO_IDS.includes(block.id))

type BlockCommand = (chain: ChainedCommands) => ChainedCommands

const COMMANDS: Record<Exclude<BlockId, 'image'>, BlockCommand> = {
  paragraph: (chain) => chain.setParagraph(),
  heading1: (chain) => chain.setHeading({ level: 1 }),
  heading2: (chain) => chain.setHeading({ level: 2 }),
  heading3: (chain) => chain.setHeading({ level: 3 }),
  bulletList: (chain) => chain.toggleBulletList(),
  orderedList: (chain) => chain.toggleOrderedList(),
  taskList: (chain) => chain.toggleTaskList(),
  blockquote: (chain) => chain.toggleBlockquote(),
  callout: (chain) => chain.setCallout('note'),
  codeBlock: (chain) => chain.setCodeBlock(),
  table: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  divider: (chain) => chain.setHorizontalRule(),
}

/** The block, applied to the current selection (inserting or converting). The image needs its dialog first. */
export function applyBlock(chain: ChainedCommands, id: Exclude<BlockId, 'image'>): ChainedCommands {
  return COMMANDS[id](chain)
}

/** Turn the current block into another; a quote or callout around it is left first, so "Text" is plain text. */
export function turnInto(editor: Editor, id: BlockId): void {
  if (id === 'image') return
  const wrappers = ['blockquote', 'callout'].filter((wrapper) => wrapper !== id && editor.isActive(wrapper))
  const lifted = wrappers.reduce((chain, wrapper) => chain.lift(wrapper), editor.chain().focus())
  if (id !== 'blockquote') {
    applyBlock(lifted, id).run()
    return
  }
  if (!editor.isActive('blockquote')) lifted.wrapIn('blockquote').run()
}
