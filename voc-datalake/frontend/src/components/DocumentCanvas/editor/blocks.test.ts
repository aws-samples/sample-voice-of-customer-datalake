import { describe, expect, it } from 'vitest'
import { applyBlock, type BlockId, SLASH_BLOCKS, TURN_INTO_BLOCKS, turnInto } from './blocks'
import { headlessEditor, markdownOf } from './headless-editor-fixtures'

/** The editor showing `markdown`, the caret in its first text. */
function editorAt(markdown: string, pos = 2) {
  const editor = headlessEditor(markdown)
  editor.commands.setTextSelection(pos)
  return editor
}

describe('the block choices', () => {
  it('offers every block of the canvas once, each with words the "/" filter matches', () => {
    expect(SLASH_BLOCKS.map((block) => block.id)).toStrictEqual([
      'paragraph', 'heading1', 'heading2', 'heading3', 'bulletList', 'orderedList', 'taskList',
      'blockquote', 'callout', 'codeBlock', 'table', 'divider', 'image',
    ])
    SLASH_BLOCKS.forEach((block) => expect(block.aliases.trim()).not.toBe(''))
  })

  it('turns a block only into the text blocks and the two wrappers', () => {
    expect(TURN_INTO_BLOCKS.map((block) => block.id)).toStrictEqual(['paragraph', 'heading1', 'heading2', 'heading3', 'blockquote', 'callout'])
  })
})

describe('applyBlock: what each block writes to the stored Markdown', () => {
  it.each<[Exclude<BlockId, 'image'>, string]>([
    ['paragraph', 'Plan'],
    ['heading1', '# Plan'],
    ['heading2', '## Plan'],
    ['heading3', '### Plan'],
    ['bulletList', '- Plan'],
    ['orderedList', '1. Plan'],
    ['taskList', '- [ ] Plan'],
    ['blockquote', '> Plan'],
    ['callout', '> [!NOTE]\n> Plan'],
    ['codeBlock', '```\nPlan\n```'],
  ])('%s', (id, expected) => {
    const editor = editorAt('Plan')
    applyBlock(editor.chain().focus(), id).run()
    expect(markdownOf(editor)).toBe(expected)
  })

  it('table: a 3 x 3 table with a header row, the caret in its first cell', () => {
    const editor = editorAt('Plan', 5)
    applyBlock(editor.chain().focus(), 'table').run()
    const table = editor.state.doc.child(1)
    const rows = Array.from({ length: table.childCount }, (_, index) => table.child(index))
    expect(table.type.name).toBe('table')
    expect(rows.map((row) => Array.from({ length: row.childCount }, (_, index) => row.child(index).type.name))).toStrictEqual([
      ['tableHeader', 'tableHeader', 'tableHeader'],
      ['tableCell', 'tableCell', 'tableCell'],
      ['tableCell', 'tableCell', 'tableCell'],
    ])
    expect(editor.state.selection.$from.node(-1).type.name).toBe('tableHeader')
  })

  it('divider: a rule after the block', () => {
    const editor = editorAt('Plan', 5)
    applyBlock(editor.chain().focus(), 'divider').run()
    expect(editor.state.doc.child(1).type.name).toBe('horizontalRule')
    expect(markdownOf(editor)).toMatch(/^Plan\n\n(?:---|\*\*\*|___)/)
  })
})

describe('turnInto', () => {
  it('turns a paragraph into a heading', () => {
    const editor = editorAt('Plan')
    turnInto(editor, 'heading2')
    expect(markdownOf(editor)).toBe('## Plan')
  })

  it('takes the text out of a quote first, so "Text" is plain text', () => {
    const editor = editorAt('> Plan', 3)
    turnInto(editor, 'paragraph')
    expect(markdownOf(editor)).toBe('Plan')
  })

  it('takes a callout\'s text out of it before making it a heading', () => {
    const editor = editorAt('> [!WARNING]\n> Plan', 3)
    turnInto(editor, 'heading1')
    expect(markdownOf(editor)).toBe('# Plan')
  })

  it('turns a quote into a callout (the quote is left, not nested)', () => {
    const editor = editorAt('> Plan', 3)
    turnInto(editor, 'callout')
    expect(markdownOf(editor)).toBe('> [!NOTE]\n> Plan')
  })

  it('turning a callout into a callout changes its kind in place, never nests a second one', () => {
    const editor = editorAt('> [!TIP]\n> Plan', 3)
    turnInto(editor, 'callout')
    expect(markdownOf(editor)).toBe('> [!NOTE]\n> Plan')
  })

  it('wraps a paragraph in a quote, and leaves a quote as it is', () => {
    const editor = editorAt('Plan')
    turnInto(editor, 'blockquote')
    expect(markdownOf(editor)).toBe('> Plan')
    turnInto(editor, 'blockquote')
    expect(markdownOf(editor)).toBe('> Plan')
  })

  it('turns a callout into a quote', () => {
    const editor = editorAt('> [!CAUTION]\n> Plan', 3)
    turnInto(editor, 'blockquote')
    expect(markdownOf(editor)).toBe('> Plan')
  })

  it('does nothing for an image (it needs its dialog first)', () => {
    const editor = editorAt('Plan')
    turnInto(editor, 'image')
    expect(markdownOf(editor)).toBe('Plan')
  })
})
