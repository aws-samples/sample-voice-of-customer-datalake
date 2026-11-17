/** Is the caret just after a "/" typed at the start of an empty-so-far text or after a space? Then the menu opens. */
import type { EditorState } from '@tiptap/pm/state'
import type { BlockChoice } from './blocks'

export interface SlashTrigger {
  /** The "/" and the filter typed after it: deleted when a block is chosen. */
  readonly from: number
  readonly to: number
  readonly query: string
}

const TRIGGER = /(?:^|\s)\/([^\s/]{0,24})$/u

export function slashTrigger(state: EditorState): SlashTrigger | null {
  const { selection } = state
  const { $from } = selection
  if (!selection.empty || $from.parent.type.name !== 'paragraph') return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const query = TRIGGER.exec(before)?.[1]
  if (query === undefined) return null
  return { from: $from.pos - query.length - 1, to: $from.pos, query }
}

export const sameTrigger = (a: SlashTrigger | null, b: SlashTrigger | null) =>
  a?.from === b?.from && a?.to === b?.to && a?.query === b?.query

export function filterBlocks(blocks: readonly BlockChoice[], query: string, label: (block: BlockChoice) => string): BlockChoice[] {
  const needle = query.toLocaleLowerCase()
  if (needle === '') return [...blocks]
  return blocks.filter((block) => `${label(block)} ${block.aliases}`.toLocaleLowerCase().includes(needle))
}
