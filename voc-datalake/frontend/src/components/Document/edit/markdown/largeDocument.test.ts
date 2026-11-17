/**
 * Large documents: the work after a change follows the change, not the document's length, and writes what the
 * whole-document path writes.
 * - The serialiser compares only the blocks an unescape touched (serialize.ts `readsTheSame`); with no definition in
 *   the text that is the whole-text comparison's answer, so each case below is written once each way and must agree.
 * - The stored text is parsed once (markdownToDoc's parse feeds the stored index) and the live document's untouched
 *   blocks are converted once (convert.ts `docToMarkdown` of `editor.state.doc`).
 */
import { Editor } from '@tiptap/core'
import type { Root } from 'mdast'
import * as fromMarkdownModule from 'mdast-util-from-markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { docToMarkdown, markdownToDoc, prepareStored } from './convert'
import { canvasExtensions } from './extensions'
import { largeMarkdown } from './large-document-fixtures'
import { mayStayOpen, parseMarkdown, readTree, serialize } from './serialize'
import * as toMdastModule from './toMdast'

const { blockToMdast } = toMdastModule

vi.mock('mdast-util-from-markdown', async (importOriginal) => {
  const original = await importOriginal<typeof fromMarkdownModule>()
  return { ...original, fromMarkdown: vi.fn(original.fromMarkdown) }
})
vi.mock('./toMdast', async (importOriginal) => {
  const original = await importOriginal<typeof toMdastModule>()
  return { ...original, blockToMdast: vi.fn(original.blockToMdast) }
})

/** The texts parsed since the last reset, longest first (only the lengths matter here). */
const parsedLengths = () => vi.mocked(fromMarkdownModule.fromMarkdown).mock.calls.map(([value]) => String(value).length)

/** Blocks whose writing depends on the unescape: citations, emphasis characters, brackets, a `*` at a line start. */
const TRICKY = [
  'Delivery is late [FR:fr_1] and *tracking* is opaque [FR:fr_2].',
  'A star * alone, an under_score, a [bracket] and [two][words].',
  '* not a list: it was escaped',
  '[label]: not a definition, only text',
  'Brackets [x] next to a link [site](https://example.com).',
  '- item with [FR:fr_3]\n- item with *em* and_under',
  '> quoted [FR:fr_4] _x_',
  '| a | b |\n| --- | --- |\n| [c] | *d* |',
  '1. one [x]\n2. two',
  '***',
  '[^1] looks like a footnote',
]

/** The editor's mdast of `markdown`, each block once with its text changed so the unescape has work to do. */
function editedTrees(markdown: string): Root[] {
  const blocks = (markdownToDoc(markdown).content ?? []).flatMap((node) => blockToMdast(node) ?? [])
  const edited = (markdownToDoc(TRICKY.map((block) => `${block} [y] *z*`).join('\n\n')).content ?? [])
    .flatMap((node) => blockToMdast(node) ?? [])
  return edited.map((block, at) => {
    const children = [...blocks]
    children.splice(at % (children.length + 1), 0, block)
    return { type: 'root', children }
  })
}

describe('serialize: the touched blocks alone decide as the whole text does', () => {
  it.each([
    ['the tricky blocks', TRICKY.join('\n\n')],
    ['a long research document', largeMarkdown(6_000)],
  ])('%s: the same bytes either way, after every edit', (_name, markdown) => {
    for (const tree of editedTrees(markdown)) {
      expect(serialize(tree, null, false)).toBe(serialize(tree, null, true))
    }
  })

  it('drops the escapes the reading allows in a touched block ([FR:id] stays as written)', () => {
    const markdown = largeMarkdown(6_000)
    const doc = markdownToDoc(markdown)
    const [, , paragraph] = doc.content ?? []
    const edited = { ...doc, content: (doc.content ?? []).map((node) => (node === paragraph ? markdownToDoc('New [FR:fr_9] *x* a_b').content?.[0] ?? node : node)) }

    const saved = docToMarkdown(edited, markdown)

    expect(saved).toContain('New [FR:fr_9] *x* a_b')
    expect(readTree(saved)).toBe(readTree(markdown.replace(/^Customers in segment 1 .*$/m, 'New [FR:fr_9] *x* a_b')))
  })

  it('keeps an escape a definition elsewhere in the text needs (the whole text is compared)', () => {
    const stored = 'Intro\n\n[x]: https://example.com/x\n\nOld'
    const doc = markdownToDoc(stored)
    const edited = { ...doc, content: [...(doc.content ?? []).slice(0, 2), ...(markdownToDoc('New [x]').content ?? [])] }

    const saved = docToMarkdown(edited, stored)

    // Unescaped, `[x]` would become a link to the definition: the text stays text.
    expect(saved).toBe('Intro\n\n[x]: https://example.com/x\n\nNew \\[x]')
    expect(readTree(saved)).toBe(readTree('Intro\n\n[x]: https://example.com/x\n\nNew \\[x]'))
  })

  it.each([
    ['an HTML comment left open', '<!-- open comment\n\nkeep'],
    ['a code fence left open', '```\nunclosed code\n'],
    ['a <pre> block left open', '<pre>\nx\n\ny'],
  ])('keeps the escapes a stored block that never closes needs (%s swallows what follows)', (_name, stored) => {
    const doc = markdownToDoc(stored)
    const edited = { ...doc, content: [...(doc.content ?? []), ...(markdownToDoc('a \\* b \\[x] a\\_b\\_c').content ?? [])] }
    const tree: Root = { type: 'root', children: [{ type: 'verbatim', value: stored }, ...(markdownToDoc('a \\* b \\[x] a\\_b\\_c').content ?? []).flatMap((node) => blockToMdast(node) ?? [])] }

    // The whole text reads as one block either way: no escape is proven droppable, so the cautious text is written.
    expect(serialize(tree, null, false)).toBe(serialize(tree, null, true))
    expect(docToMarkdown(edited, stored)).toContain('a \\* b \\[x]')
  })

  it.each<[source: string, open: boolean]>([
    ['```ts\nconst x = 1\n```', false],
    ['~~~~\ncode\n~~~~  ', false],
    ['````\ncode\n```', true],
    ['```\nunclosed code\n', true],
    ['```', true],
    ['<!-- note -->', false],
    ['<!-- open\n\nstill open', true],
    ['<PRE>\nx\n</pre>', false],
    ['<script>\nlet a\n', true],
    ['<?php echo 1 ?>', false],
    ['<![CDATA[ x', true],
    ['<!DOCTYPE html>', false],
    ['<div>\nends at a blank line', false],
    ['<preview>text</preview>', false],
    ['Plain text with ``` inside', false],
  ])('mayStayOpen(%j) is %s', (source, open) => {
    expect(mayStayOpen(source)).toBe(open)
  })

  // The parser's end markers, not a browser's: `--!>` ends a comment in a browser but not in Markdown, and a comment's
  // `-->` or an instruction's `?>` may overlap its opener. Each case is checked against the parser itself.
  it.each<[source: string, open: boolean]>([
    ['<!-- note --!>', true],
    ['<!-- note --!> and later -->', false],
    ['<!-- neither end', true],
    ['<!-->', false],
    ['<!--->', false],
    ['<!---->', false],
    ['<?>', false],
    ['<![CDATA[ x ]>', true],
    ['<![CDATA[ x ]]>', false],
    ['<Script>\nlet a\n</SCRIPT>', false],
  ])('mayStayOpen(%j) is %s, as the parser reads it', (source, open) => {
    expect(mayStayOpen(source)).toBe(open)
    expect(parseMarkdown(`${source}\n\nnext`).children).toHaveLength(open ? 1 : 2)
  })

  it('keeps an escape whose unescaped reading defines a target (a definition in the touched block)', () => {
    const tree: Root = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: '[a]: b' }] }, { type: 'paragraph', children: [{ type: 'text', value: 'see [a]' }] }] }

    expect(serialize(tree, null, false)).toBe(serialize(tree, null, true))
    expect(parseMarkdown(serialize(tree, null, false)).children.map((node) => node.type)).toStrictEqual(['paragraph', 'paragraph'])
  })
})

const LABELS = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' } as const
const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  vi.mocked(fromMarkdownModule.fromMarkdown).mockClear()
})

function editorOf(markdown: string): Editor {
  const editor = new Editor({
    extensions: canvasExtensions({ placeholder: '', calloutLabels: LABELS, taskLabel: () => 'Done', emptyClass: 'empty' }),
    content: markdownToDoc(markdown),
  })
  editors.push(editor)
  return editor
}

/** Type `text` at the start of the paragraph after the document's first heading of section `n`. */
function typeInSection(editor: Editor, n: number, text: string) {
  const starts: number[] = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'paragraph' && node.textContent.startsWith(`Customers in segment ${String(n)} `)) starts.push(offset + 1)
  })
  editor.commands.insertContentAt(starts[0] ?? -1, text)
}

describe('docToMarkdown of the live document, on a large document', () => {
  const markdown = largeMarkdown(200_000)

  it('is a document of more than 200,000 characters (Revise from comments refuses one over 60,000; the canvas edits it)', () => {
    expect(markdown.length).toBeGreaterThan(200_000)
  })

  it('writes what the JSON path writes, after edits with escapes, with untouched blocks byte for byte', () => {
    const editor = editorOf(markdown)
    // Typed text: the `*` is a character, not emphasis, so it keeps its escape; the brackets and `_` need none.
    typeInSection(editor, 7, 'Now [FR:fr_99] and *a* b_c ')
    typeInSection(editor, 120, '[x] ')

    const saved = docToMarkdown(editor.state.doc, markdown)

    expect(saved).toBe(docToMarkdown(editor.getJSON(), markdown))
    expect(saved).toBe(markdown
      .replace('Customers in segment 7 ', 'Now [FR:fr_99] and \\*a\\* b_c Customers in segment 7 ')
      .replace('Customers in segment 120 ', '[x] Customers in segment 120 '))
  })

  it('gives back the stored text for an untouched document, and for an edit undone by hand', () => {
    const editor = editorOf(markdown)
    expect(docToMarkdown(editor.state.doc, markdown)).toBe(markdown)

    typeInSection(editor, 3, 'x')
    editor.commands.deleteRange({ from: editor.state.selection.from - 1, to: editor.state.selection.from })

    expect(docToMarkdown(editor.state.doc, markdown)).toBe(markdown)
  })

  it('parses the stored text once: the editor\'s first change reuses the parse markdownToDoc made', () => {
    const editor = editorOf(markdown)
    expect(parsedLengths().filter((length) => length >= markdown.length)).toHaveLength(1)

    typeInSection(editor, 7, 'Now [FR:fr_99] *a* ')
    docToMarkdown(editor.state.doc, markdown)
    typeInSection(editor, 8, 'and [y] ')
    docToMarkdown(editor.state.doc, markdown)

    // Each change reads only its touched block again, never the whole text.
    expect(parsedLengths().filter((length) => length >= markdown.length)).toHaveLength(1)
    expect(Math.max(...parsedLengths().slice(1))).toBeLessThan(1_000)
  })

  it('converts each untouched block once: a later change converts only the block it changed', () => {
    const editor = editorOf(markdown)
    docToMarkdown(editor.state.doc, markdown)
    vi.mocked(blockToMdast).mockClear()

    typeInSection(editor, 7, 'x')
    docToMarkdown(editor.state.doc, markdown)

    expect(vi.mocked(blockToMdast)).toHaveBeenCalledTimes(1)
  })

  it('prepareStored indexes a saved text ahead, so the change after a save parses nothing whole', () => {
    const editor = editorOf(markdown)
    typeInSection(editor, 7, 'Saved ')
    const saved = docToMarkdown(editor.state.doc, markdown)
    prepareStored(saved)
    vi.mocked(fromMarkdownModule.fromMarkdown).mockClear()

    typeInSection(editor, 9, 'Then [z] ')
    const next = docToMarkdown(editor.state.doc, saved)

    expect(next).toBe(saved.replace('Customers in segment 9 ', 'Then [z] Customers in segment 9 '))
    expect(parsedLengths().every((length) => length < 1_000)).toBe(true)
  })
})
