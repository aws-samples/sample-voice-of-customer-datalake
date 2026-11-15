/**
 * The canvas must not change what a document says. For every document shape the product writes today (the
 * hand-written templates, the Lambdas' generated layouts, every dev-mock document, the test fixtures), reading
 * the Markdown into the editor and writing it back gives the same tree (positions aside), writing twice gives
 * the same bytes, and given the stored text an untouched document comes back byte for byte.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { Nodes, Root, RootContent } from 'mdast'
import { docToMarkdown, markdownToDoc } from './convert'
import { canvasExtensions } from './extensions'
import { readTree, serialize } from './serialize'
import { blockToMdast } from './toMdast'

const VOC = join(import.meta.dirname, '../../../../..')
const SCHEMA_OPTIONS = {
  placeholder: '', calloutLabels: { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' },
  taskLabel: () => 'Done', emptyClass: 'empty',
} as const
const read = (file: string) => readFileSync(join(VOC, file), 'utf8')

/** A model-written section, as the writer prompts ask for it (bold lead-ins, lists, quotes, citations). */
const SECTION = [
  '1. **Late deliveries** dominate negative feedback (62% of delivery mentions) [FR:fr_1].',
  '2. **Tracking opacity** amplifies frustration more than lateness itself [FR:fr_2] [FR:fr_10].',
  '',
  '- Customers on the *mobile app* mention it twice as often as web users',
  '- "Where is my order?" contacts rose 18% month over month',
  '',
  '> "I just want to know when it will arrive." (App Store review, 2 stars)',
  '',
  '**Confidence:** High: 214 of 260 reviews agree.',
].join('\n')

const INLINE = 'Delivery delays'

// ── Extraction of the documents from their sources ─────────────────────────────────────────────────────

const unescapePython = (body: string) =>
  body.replace(/\\([nt'"\\])/g, (_m, c: string) => ({ n: '\n', t: '\t' })[c] ?? c)

/** `TEMPLATES` of lambda/shared/human_documents.py: each entry is a run of single-quoted string literals. */
function humanTemplates(): [string, string][] {
  const text = read('lambda/shared/human_documents.py')
  const block = text.slice(text.indexOf('TEMPLATES: Final = {'), text.indexOf('\n}\n', text.indexOf('TEMPLATES: Final = {')))
  return [...block.matchAll(/'(\w+)': \(\n([\s\S]*?)\n {4}\),/g)].map(([, name, body]) => [
    `human template ${name ?? ''}`,
    [...(body ?? '').matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(([, part]) => unescapePython(part ?? '')).join(''),
  ])
}

/** A Python f-string with each `{expression}` replaced: a whole-line one by a section, an inline one by text. */
function fillFString(template: string): string {
  const filled = template
    .replaceAll('{{', '\u0001')
    .replaceAll('}}', '\u0002')
    .replace(/\{[^{}]*\}/g, '\u0000')
    .replaceAll('\u0001', '{')
    .replaceAll('\u0002', '}')
  return filled
    .split('\n')
    .map((line) => (line === '\u0000' ? SECTION : line.replaceAll('\u0000', INLINE)))
    .join('\n')
}

function fStrings(file: string, variable: string): [string, string][] {
  const text = read(file)
  return [...text.matchAll(new RegExp(`${variable} = f"""([\\s\\S]*?)"""`, 'g'))].map(([, body], index) => [
    `${file} ${variable} #${index + 1}`,
    fillFString(body ?? ''),
  ])
}

const unescapeJs = (body: string) =>
  body.replace(/\\(u\{[\da-f]+\}|u[\da-f]{4}|.)/gi, (_m, c: string) => {
    if (c.startsWith('u')) return String.fromCodePoint(Number.parseInt(c.replace(/[u{}]/g, ''), 16))
    return ({ n: '\n', t: '\t' })[c] ?? c
  })

/** A JS template literal with each `${expression}` replaced by its `|| 'fallback'` or by sample text. */
function fillTemplate(body: string): string {
  return unescapeJs(body.replace(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_m, expression: string) => {
    const fallback = /\|\|\s*'([^']*)'\s*$/.exec(expression)
    return fallback?.[1] ?? INLINE
  }))
}

/** Every document the dev mock defines: each string or template literal holding a Markdown document. */
function mockDocuments(): [string, string][] {
  return ['mock-server.js', 'mock-project-actions.js', 'mock-decisions.js'].flatMap((file) => {
    const text = read(`frontend/${file}`)
    const quoted = [...text.matchAll(/'(# (?:[^'\\]|\\.)*)'/g)].map(([, body]) => unescapeJs(body ?? ''))
    const templates = [...text.matchAll(/`(# (?:[^`\\]|\\.)*)`/g)].map(([, body]) => fillTemplate(body ?? ''))
    return [...quoted, ...templates]
      .filter((doc) => doc.includes('\n'))
      .map((doc, index): [string, string] => [`${file} #${index + 1}`, doc])
  })
}

/** Shapes the Lambdas write with code rather than one literal, rebuilt here as their code assembles them. */
const WRITTEN: [string, string][] = [
  ['decision record (decision_records.render_content)', [
    '# Ship proactive delay alerts', '', '**Verdict:** Go', '', '## Rationale', '', 'Late deliveries lead the negative feedback.',
    '', '## Success metric', '', 'WISMO contacts down 30%', '', '## Dates', '', '- Review by: 2026-12-01',
    '', '## Evidence', '', '- Feedback: fb_1', '- Document: doc_2', '',
  ].join('\n')],
  ['press release (prfaq-generation prompt contract)', [
    '# PR/FAQ: Proactive Delivery Updates', '', '## Press Release', '',
    '### Acme Outfitters tells you about a delay before you have to ask', '',
    '*Customers hear about every estimate change within five minutes, with the reason.*', '',
    'PORTLAND — 2027-03-01 — Acme Outfitters today launched proactive delivery updates [FR:fr_1].', '',
    '**How it works:**', '', '1. You place an order.', '2. We watch the carrier events.', '3. You get a message when the estimate moves.', '',
    '**Availability:** Every order in the US, from launch day.', '', '"We built this because 62% of delivery complaints were about silence," said the Head of Fulfilment.', '',
    '---', '', '## Frequently Asked Questions', '', '### Customer FAQ', '',
    '**Q: Will I be spammed with notifications?**', '', 'No — you are only notified when the estimate changes.', '',
    '### Internal FAQ', '', '**Q: What is the hardest technical dependency?**', '', 'Carrier webhook latency (p95 4 min) and estimate recalculation.', '',
  ].join('\n')],
  ['PRD (prd-generation prompt contract)', [
    '# PRD: Proactive delivery updates', '', '## 1. Executive Summary', '', 'Customers want to know before they ask.', '',
    '## 2. Requirements', '', '| Priority | Requirement | Evidence |', '|:---|:---:|---:|',
    '| P0 | Notify within 5 minutes | [FR:fr_1] |', '| P1 | Show the reason | `reason_code` |', '',
    '- [ ] Carrier webhook contract', '- [x] Estimate model v2', '',
  ].join('\n')],
  ['display text with linked citations (featureRequestCitations)', 'See [\\[FR:fr_1\\]](/feature-requests?request=fr_1) and [\\[FR:fr_2\\]](/feature-requests?request=fr_2).\n'],
  ['raw HTML (document_generator stored-content test)', '# PR/FAQ: Fast\n\nUse <b>bold</b> and a < b.\n'],
  ['frontend fixtures', '# Overview\n\nTest content.'],
  ['document review fixture', '## Customer problem\n\nCustomers wait two weeks for a refund.'],
  ['versions fixture', '# Launch\nShip on Friday'],
  ['export menu fixture', '# Title\n\nSome **bold** text and a [link](https://example.com).\n'],
  ['citations fixture', 'Customers asked [FR:fr_1], [FR:abc] and [R:abc]; [FR:has space] is not a citation.\n'],
]

const CORPUS: [string, string][] = [
  ...humanTemplates(),
  ...fStrings('lambda/research/research_step_handler.py', 'full_report'),
  ...fStrings('lambda/api/projects.py', 'full_report'),
  ...fStrings('lambda/jobs/document_generator/handler.py', 'full_document'),
  ...mockDocuments(),
  ...WRITTEN,
]

describe('the round-trip corpus', () => {
  it('collects every source (templates, generated layouts, mock documents, fixtures)', () => {
    const names = CORPUS.map(([name]) => name)
    expect(names.filter((name) => name.startsWith('human template'))).toHaveLength(2)
    expect(names.filter((name) => name.includes('full_report')).length).toBeGreaterThanOrEqual(2)
    expect(names.filter((name) => name.includes('full_document'))).toHaveLength(1)
    expect(names.filter((name) => name.startsWith('mock-')).length).toBeGreaterThanOrEqual(10)
  })
})

describe.each(CORPUS)('%s', (_name, markdown) => {
  it('reads back as the same tree', () => {
    expect(readTree(docToMarkdown(markdownToDoc(markdown)))).toBe(readTree(markdown))
  })

  it('writes the same bytes twice', () => {
    const once = docToMarkdown(markdownToDoc(markdown))
    expect(docToMarkdown(markdownToDoc(once))).toBe(once)
  })

  it('comes back byte for byte when nothing changed', () => {
    expect(docToMarkdown(markdownToDoc(markdown), markdown)).toBe(markdown)
  })

  it('writes from the editor\'s live document what it writes from the JSON (the path the canvas takes)', () => {
    const editor = new Editor({ extensions: canvasExtensions(SCHEMA_OPTIONS), content: markdownToDoc(markdown) })
    try {
      expect(docToMarkdown(editor.state.doc, markdown)).toBe(markdown)
      expect(docToMarkdown(editor.state.doc)).toBe(docToMarkdown(markdownToDoc(markdown)))
    } finally {
      editor.destroy()
    }
  })

  it('writes the bytes the whole-text check writes, alone and with each block edited (serialize.ts readsTheSame)', () => {
    const blocks = (markdownToDoc(markdown).content ?? []).flatMap((node) => blockToMdast(node) ?? [])
    const trees: Root[] = [{ type: 'root', children: blocks }, ...blocks.map((_block, at) => ({
      type: 'root' as const,
      children: blocks.map((block, index) => (index === at ? withText(block, ' [x] *y* a_b') : block)),
    }))]
    for (const tree of trees) expect(serialize(tree, null, false)).toBe(serialize(tree, null, true))
  })
})

/** The block with `text` added to its first text (an edit the unescape has work on). */
function withText(block: RootContent, text: string): RootContent {
  const copy = structuredClone(block)
  const visit = (node: Nodes): boolean => {
    if (node.type === 'text') {
      node.value += text
      return true
    }
    return 'children' in node && node.children.some((child: Nodes) => visit(child))
  }
  visit(copy)
  return copy
}
