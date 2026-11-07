/**
 * @fileoverview A document says what it was made without, from the block the server stored on it:
 * each known code in the reader's language, an unknown code in the server's words, a hand-written
 * document's `evidence: 0` in its own sentence, nothing for a document with no gaps.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MethodologyNotice } from './MethodologyNotice'
import { normalizeProjectDocument } from '../../api/projectDetailSchema'

const DOC = { document_id: 'prd_1', document_type: 'prd', title: 'Refunds PRD', content: 'Body', created_at: '2026-11-07T00:00:00Z' }

function notice(methodology: unknown, extra: Record<string, unknown> = {}): string | null {
  const doc = normalizeProjectDocument({ ...DOC, ...extra, methodology })
  if (doc === null) throw new Error('the fixture document must normalize')
  const { unmount } = render(<MethodologyNotice doc={doc} />)
  const text = screen.queryByTestId('document-methodology')?.textContent ?? null
  unmount()
  return text
}

describe('MethodologyNotice', () => {
  it('names a missing and an unselected upstream step, and the reference documents the cap left out', () => {
    const text = notice({
      step: 'prd',
      skipped: [{ step: 'prfaq', reason: 'missing' }, { step: 'personas', reason: 'not_selected' }],
      warnings: [
        { code: 'missing_upstream', step: 'prfaq', message: 'server' },
        { code: 'upstream_not_selected', step: 'personas', message: 'server' },
        { code: 'reference_documents_skipped', message: 'server', document_ids: ['d4', 'd5'], cap: 3 },
      ],
      evidence: 20,
    })
    expect(text).toContain('Made without a PR/FAQ: the project had none.')
    expect(text).toContain("Made without the project's personas: they were not selected.")
    expect(text).toContain('2 selected reference documents were left out (only the first 3 are read).')
  })

  it('says a generated document cites no evidence, and a hand-written one in its own words', () => {
    const block = { step: 'prd', skipped: [], warnings: [{ code: 'no_evidence', message: 'server' }], evidence: 0 }
    expect(notice(block)).toContain('Cites no customer evidence.')
    expect(notice(block, { origin: 'human' })).toContain('Written by hand: cites no customer feedback yet.')
  })

  it("shows the server's sentence for a code or step this client does not know", () => {
    const text = notice({
      step: 'prd', skipped: [],
      warnings: [
        { code: 'some_future_code', message: 'A future gap, in English.' },
        { code: 'missing_upstream', step: 'research', message: 'Made without research.' },
      ],
    })
    expect(text).toContain('A future gap, in English.')
    expect(text).toContain('Made without research.')
  })

  it('renders nothing without warnings, or for a document made before the block existed', () => {
    expect(notice({ step: 'prd', skipped: [], warnings: [], evidence: 14 })).toBeNull()
    expect(notice(undefined)).toBeNull()
  })
})
