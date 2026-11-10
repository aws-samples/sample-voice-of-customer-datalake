/**
 * Live finding: in a document's markdown table the first column broke words letter by
 * letter. `overflow-wrap: anywhere` / `word-break: break-word` let a column's minimum
 * width collapse to one character. Cells now keep words whole (`break-word` breaks a
 * long token only when it would overflow), keep a minimum width, and a wide table
 * scrolls sideways instead of squeezing. jsdom has no layout, so the rules are pinned.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8')
const documentsTab = readFileSync(resolve(__dirname, './DocumentsTab.tsx'), 'utf8')

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  return start < 0 ? '' : css.slice(start, css.indexOf('}', start))
}

describe('markdown tables in documents', () => {
  it('cells keep words whole and a readable minimum width', () => {
    const cell = rule('.md-content :where(th, td)')
    expect(cell).toMatch(/word-break: normal/)
    expect(cell).toMatch(/overflow-wrap: break-word/)
    expect(cell).toMatch(/min-width: \d/)
  })

  it('a wide table scrolls sideways', () => {
    expect(rule('.md-content table')).toMatch(/display: block;.*max-width: 100%;.*overflow-x: auto/)
  })

  it('the document pane does not force letter-by-letter breaking again', () => {
    expect(documentsTab).not.toMatch(/wordBreak|word-break/)
  })
})
