/**
 * The names a blank document starts with (blankTitles.ts): the base name while it is free, else the first free
 * numbered one; a custom document's name is compared with the research / custom titles as people read them, a PRD /
 * PR/FAQ's with its type's series (so "Checkout — PRD (v2)" holds "checkout" for a PRD, not for a PR/FAQ).
 */
import { describe, expect, it } from 'vitest'
import { firstFreeTitle, isTitleTaken } from './blankTitles'
import type { ProjectDocument } from '../../api/types'

function doc(type: string, title: string, baseTitle?: string): ProjectDocument {
  return { document_id: `${type}-${title}`, document_type: type, title, base_title: baseTitle, content: '', created_at: '' }
}

const numbered = (n: number) => `Untitled document ${String(n)}`

describe('firstFreeTitle', () => {
  it('keeps the base name while no document has it', () => {
    expect(firstFreeTitle('custom', 'Untitled document', numbered, [doc('custom', 'Notes')])).toBe('Untitled document')
  })

  it('numbers from 2 past every name taken, as people read them (case, spacing)', () => {
    const documents = [doc('custom', 'untitled  DOCUMENT'), doc('research', 'Untitled document 2'), doc('custom', 'Untitled document 4')]
    expect(firstFreeTitle('custom', 'Untitled document', numbered, documents)).toBe('Untitled document 3')
  })

  it('counts a PRD named the same as a custom document as no clash for a custom one', () => {
    expect(firstFreeTitle('custom', 'Untitled document', numbered, [doc('prd', 'Untitled document (v1)', 'Untitled document')]))
      .toBe('Untitled document')
  })

  it('numbers a PRD past its type\'s series only', () => {
    const prdNumbered = (n: number) => `Untitled PRD ${String(n)}`
    const documents = [doc('prd', 'Untitled PRD (v3)', 'Untitled PRD'), doc('prfaq', 'Untitled PRD 2 (v1)', 'Untitled PRD 2')]
    expect(firstFreeTitle('prd', 'Untitled PRD', prdNumbered, documents)).toBe('Untitled PRD 2')
  })
})

describe('isTitleTaken', () => {
  it('holds a PRD series by its key: version and own-type label dropped, any case', () => {
    const documents = [doc('prd', 'Checkout — PRD (v2)')]
    expect(['checkout', 'Checkout (v9)', 'Checkout — PRD', 'Checkout 2'].map((title) => isTitleTaken('prd', title, documents)))
      .toStrictEqual([true, true, true, false])
    expect(isTitleTaken('prfaq', 'Checkout', documents)).toBe(false)
  })
})
