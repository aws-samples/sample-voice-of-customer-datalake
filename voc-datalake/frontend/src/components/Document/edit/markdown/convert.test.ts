import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { docToMarkdown, markdownToDoc } from './convert'
import { readTree } from './serialize'

const fresh = (markdown: string) => docToMarkdown(markdownToDoc(markdown))

/** Fresh serialisation reads back as the same tree, and is stable. */
function expectLossless(markdown: string) {
  const once = fresh(markdown)
  expect(readTree(once)).toBe(readTree(markdown))
  expect(fresh(once)).toBe(once)
  return once
}

const blocks = (markdown: string) => markdownToDoc(markdown).content ?? []

describe('markdownToDoc', () => {
  it('maps every block of the contract to its node', () => {
    const types = blocks([
      '# H1', '## H2', '#### H4', '###### H6', 'Para', '- a', '1. b', '- [ ] c', '> q', '> [!TIP]\n> t',
      '```js\nx\n```', '| a |\n| - |\n| 1 |', '---', '![alt](/x.png)', '<div>raw</div>',
    ].join('\n\n')).map((node) => node.type)
    expect(types).toStrictEqual([
      'heading', 'heading', 'heading', 'heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote',
      'callout', 'codeBlock', 'table', 'horizontalRule', 'paragraph', 'rawBlock',
    ])
  })

  it('keeps heading levels 5 and 6 (the schema is lossless; only the menu offers 1-3)', () => {
    expect(blocks('##### Five\n\n###### Six').map((node): unknown => node.attrs?.level)).toStrictEqual([5, 6])
  })

  it('reads an empty document as one empty paragraph', () => {
    expect(markdownToDoc('')).toStrictEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(docToMarkdown(markdownToDoc(''))).toBe('')
  })

  it('reads each GFM alert kind as a callout', () => {
    const kinds = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map((kind) => blocks(`> [!${kind}]\n> Body`)[0])
    expect(kinds.map((node): unknown => node?.attrs?.kind)).toStrictEqual(['note', 'tip', 'important', 'warning', 'caution'])
  })

  it('leaves a quote with an unknown or inline marker a quote', () => {
    expect(blocks('> [!FOO]\n> x')[0]?.type).toBe('blockquote')
    expect(blocks('> [!NOTE] same line')[0]?.type).toBe('blockquote')
  })

  it('keeps raw HTML, footnotes and definitions as raw Markdown with their exact source', () => {
    const doc = blocks('A<sup>1</sup>[^n] [x]\n\n[^n]: Note *here*.\n\n[x]: https://example.com "Title"\n\n<!-- comment -->')
    expect(doc.slice(1).map((node): unknown => node.attrs?.source)).toStrictEqual(['[^n]: Note *here*.', '[x]: https://example.com "Title"', '<!-- comment -->'])
    expect(doc[0]?.content?.filter((node) => node.type === 'rawInline').map((node): unknown => node.attrs?.source)).toStrictEqual(['<sup>', '</sup>', '[^n]', '[x]'])
  })

  it('keeps a soft line break inside the paragraph text', () => {
    expect(blocks('**Generated:** 2026-11-11\n**Filters:** All | All')[0]?.content?.[1]?.text).toBe(' 2026-11-11\n')
  })
})

describe('docToMarkdown: lossless for each block', () => {
  it.each([
    ['headings', '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n'],
    ['nested lists', '- a\n  - b\n    1. c\n    2. d\n- e\n'],
    ['loose list', '- a\n\n- b\n'],
    ['ordered start', '3. three\n4. four\n'],
    ['tasks', '- [ ] open\n- [x] done\n  - [ ] nested\n'],
    ['ordered tasks', '1. [x] one\n2. [ ] two\n'],
    ['mixed checked list stays a list', '- [ ] task\n- plain\n'],
    ['table with alignment', '| L | C | R | N |\n| :- | :-: | -: | - |\n| `a\\|b` | **b** | [c](/c) | |\n'],
    ['callout', '> [!WARNING]\n> Careful **now**\n>\n> - item\n'],
    ['split callout', '> [!NOTE]\n>\n> Body\n'],
    ['empty callout', '> [!CAUTION]\n'],
    ['quote in list', '- > quoted\n  > more\n'],
    ['code with language and meta', '```ts title="a.ts"\nconst a = `x`\n```\n'],
    ['code without language', '```\nplain\n```\n'],
    ['tilde fence content with backticks', '````md\n```\ninner\n```\n````\n'],
    ['divider', 'a\n\n---\n\nb\n'],
    ['image with title', '![A chart](https://example.com/c.png "Monthly")\n'],
    ['link with title', '[docs](https://example.com "The docs") and <https://example.com>\n'],
    ['link in emphasis and emphasis in link', '*see [the **report**](/r)* and [*x*](/y)\n'],
    ['hard breaks', 'one\\\ntwo  \nthree\n'],
    ['strike and code', '~~gone~~ and `code` and **`bold code`**\n'],
    ['raw html block and inline', '<details>\n<summary>More</summary>\n\nHidden\n\n</details>\n\nA <kbd>K</kbd>\n'],
    ['footnotes', 'Claim[^1].\n\n[^1]: Source: *survey*.\n'],
    ['reference links', '[text][ref] and ![img][pic]\n\n[ref]: /a\n[pic]: /b.png\n'],
    ['entities and escapes', 'AT&amp;T &copy; \\# not a heading \\- not a list 1\\. not ordered\n'],
    ['html in a list item', '- <span>x</span>\n- y\n'],
    ['two adjacent lists', '- a\n- b\n\n* c\n'],
  ])('%s', (_name, markdown) => {
    expectLossless(markdown)
  })

  it('adds the trailing newline a document without one lacks', () => {
    expect(fresh('# Title\n\nBody')).toBe('# Title\n\nBody\n')
  })
})

describe('docToMarkdown: escaping', () => {
  it('writes citations, snake_case and spaced asterisks unescaped', () => {
    const markdown = 'Seen in [FR:fr_1] and [FR:abc_def]; snake_case_name; 2 * 3 * 4.\n'
    expect(fresh(markdown)).toBe(markdown)
  })

  it('still escapes what would change the reading', () => {
    const doc: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '*not emphasis* and [x](y) and # no' }] }] }
    const markdown = docToMarkdown(doc)
    expect(readTree(markdown)).toBe(readTree('\\*not emphasis\\* and \\[x](y) and # no'))
  })

  it('keeps an escaped bracket that a definition would turn into a link', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'See [ref] here' }] },
        { type: 'rawBlock', attrs: { source: '[ref]: https://example.com' } },
      ],
    }
    const markdown = docToMarkdown(doc)
    expect(markdown).toContain('\\[ref]')
    expect(readTree(markdown)).not.toContain('"type":"linkReference"')
  })

  it('writes a callout marker as it is', () => {
    const doc: JSONContent = { type: 'doc', content: [{ type: 'callout', attrs: { kind: 'important' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read me' }] }] }] }
    expect(docToMarkdown(doc)).toBe('> [!IMPORTANT]\n> Read me\n')
  })
})

describe('docToMarkdown with the stored text: untouched blocks keep their bytes', () => {
  const stored = '# Title\n\n_One sentence._\n\n- Goal: \n- Non-goal: \n\n| # | Requirement |\n|---|---|\n| 1 | |\n\nLast [FR:fr_1]   \n'

  const edited = (change: (content: JSONContent[]) => JSONContent[]) => {
    const doc = markdownToDoc(stored)
    return docToMarkdown({ ...doc, content: change(doc.content ?? []) }, stored)
  }

  it('returns the stored text exactly when nothing changed', () => {
    expect(docToMarkdown(markdownToDoc(stored), stored)).toBe(stored)
  })

  it('rewrites only the changed block', () => {
    const markdown = edited((content) => content.map((node, index) =>
      index === 1 ? { type: 'paragraph', content: [{ type: 'text', text: 'Changed', marks: [{ type: 'italic' }] }] } : node))
    expect(markdown).toBe('# Title\n\n*Changed*\n\n- Goal: \n- Non-goal: \n\n| # | Requirement |\n|---|---|\n| 1 | |\n\nLast [FR:fr_1]   \n')
  })

  it('keeps the original separators between blocks that stay neighbours', () => {
    const tight = '## Executive Summary\nCustomers wait.\n\n## Next\nMore.'
    const doc = markdownToDoc(tight)
    const content = doc.content ?? []
    const markdown = docToMarkdown({ ...doc, content: [...content.slice(0, 3), { type: 'paragraph', content: [{ type: 'text', text: 'Less.' }] }] }, tight)
    expect(markdown).toBe('## Executive Summary\nCustomers wait.\n\n## Next\n\nLess.')
  })

  it('keeps a stored text without a trailing newline without one after an edit', () => {
    const bare = '# Title\n\nBody'
    const doc = markdownToDoc(bare)
    const content = doc.content ?? []
    const markdown = docToMarkdown({ ...doc, content: [content[0] ?? {}, { type: 'paragraph', content: [{ type: 'text', text: 'Edited' }] }] }, bare)
    expect(markdown).toBe('# Title\n\nEdited')
  })

  it('keeps the one trailing newline of a stored text that has it', () => {
    const markdown = edited((content) => [...content.slice(0, -1), { type: 'paragraph', content: [{ type: 'text', text: 'Edited' }] }])
    expect(markdown.endsWith('| 1 | |\n\nEdited\n')).toBe(true)
  })

  it('writes a blank document as stored documents are: no trailing newline', () => {
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First words' }] }] }, '')).toBe('First words')
    expect(docToMarkdown({ type: 'doc', content: [{ type: 'paragraph' }] }, '')).toBe('')
  })

  it('keeps a stored link to another host as text (never rewritten), the canvas only refuses to render it', () => {
    const risky = 'Intro\n\n[x](//evil.example)'
    const doc = markdownToDoc(risky)
    const content = doc.content ?? []
    expect(docToMarkdown({ ...doc, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New' }] }, ...content.slice(1)] }, risky))
      .toBe('New\n\n[x](//evil.example)')
  })

  it('rewrites a list that would merge with the list before it once the block between is gone', () => {
    const lists = '- a\n\nBetween\n\n- b\n'
    const doc = markdownToDoc(lists)
    const content = doc.content ?? []
    const markdown = docToMarkdown({ ...doc, content: [content[0] ?? {}, content[2] ?? {}] }, lists)
    expect(readTree(markdown)).toBe(readTree('- a\n\n* b\n'))
  })

  it('handles a moved block', () => {
    const markdown = edited((content) => [content[1] ?? {}, content[0] ?? {}, ...content.slice(2)])
    expect(markdown.startsWith('_One sentence._\n\n# Title\n\n- Goal: \n')).toBe(true)
  })
})
