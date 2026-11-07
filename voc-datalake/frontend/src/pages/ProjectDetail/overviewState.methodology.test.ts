/**
 * @fileoverview The Overview cards render the SERVER's methodology list (`GET /projects/{id}` →
 * `methodology`, lambda/shared/methodology.py) and fall back to the local reading only for an
 * older API; the hints name the steps the server listed.
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { deriveOverviewState } from './overviewState'
import { documentsHint, researchHint } from './methodologyHint'
import { overviewDoc as doc, overviewPersona as persona } from './project-detail-fixtures'
import type { ProjectMethodology } from '../../api/methodologySchema'

const t = i18n.getFixedT('en', 'projectDetail')

function overview(steps: ProjectMethodology['steps']): ProjectMethodology {
  return { order: ['personas', 'research', 'prfaq', 'prd', 'prototype'], steps }
}

const EMPTY_PROJECT = overview({
  personas: { missing: [], count: 0 },
  research: { missing: ['personas'], count: 0 },
  prfaq: { missing: ['personas'], count: 0 },
  prd: { missing: ['personas', 'prfaq'], count: 0 },
  prototype: { missing: ['prd', 'prfaq'], count: 0, blocked: true },
})

describe('deriveOverviewState with the server methodology', () => {
  it("takes the server's lists: research misses personas, documents miss personas and the PR/FAQ", () => {
    const { steps } = deriveOverviewState({ personas: [], documents: [], methodology: EMPTY_PROJECT })
    expect(steps.research).toMatchObject({ missingUpstream: true, missingSteps: ['personas'] })
    expect(steps.documents).toMatchObject({ missingUpstream: true, missingSteps: ['personas', 'prfaq'] })
    expect(steps.prototype.missingUpstream).toBe(true)
  })

  it('follows the server where the local reading would differ', () => {
    // Locally: research exists, so the documents card had no hint. The server says personas are missing.
    const methodology = overview({
      research: { missing: ['personas'], count: 1 },
      prfaq: { missing: ['personas'], count: 0 },
      prd: { missing: ['personas', 'prfaq'], count: 0 },
      prototype: { missing: ['prd', 'prfaq'], count: 0, blocked: false },
    })
    const { steps } = deriveOverviewState({ personas: [], documents: [doc('r1', 'research')], methodology })
    expect(steps.documents.missingUpstream).toBe(true)
    // The server's `blocked` wins over the local document count.
    expect(steps.prototype.missingUpstream).toBe(false)
  })

  it('has no gap and no hint when the server lists none', () => {
    const methodology = overview({
      research: { missing: [], count: 0 }, prfaq: { missing: [], count: 1 }, prd: { missing: [], count: 0 },
      prototype: { missing: ['prd'], count: 0, blocked: false },
    })
    const { steps } = deriveOverviewState({ personas: [persona('p1')], documents: [doc('f1', 'prfaq')], methodology })
    expect(steps.documents).toMatchObject({ missingUpstream: false, missingSteps: [] })
    expect(documentsHint(steps.documents, t)).toBeUndefined()
    expect(researchHint(steps.research, t)).toBeUndefined()
  })

  it('falls back to the local reading, with no list, for an older API', () => {
    const { steps } = deriveOverviewState({ personas: [], documents: [] })
    expect([steps.research.missingUpstream, steps.prototype.missingUpstream]).toStrictEqual([true, true])
    expect([steps.research.missingSteps, steps.documents.missingSteps]).toStrictEqual([undefined, undefined])
  })

  it("keeps the cards' earlier hints for an older API", () => {
    const { steps } = deriveOverviewState({ personas: [], documents: [] })
    expect(researchHint(steps.research, t)).toBe('Generate personas first to ground the research in them.')
    expect(documentsHint(steps.documents, t)).toBe('Personas or research make these documents stronger.')
  })

  it('names each step the server listed in the documents hint', () => {
    const { steps } = deriveOverviewState({ personas: [], documents: [], methodology: EMPTY_PROJECT })
    expect(documentsHint(steps.documents, t)).toBe(
      'Generate personas first: the methodology writes the PR/FAQ and PRD from them. '
      + 'Write the PR/FAQ before the PRD: the methodology reads it.',
    )
    expect(researchHint(steps.research, t)).toBe('Generate personas first to ground the research in them.')
  })

  it("keeps the card's own hint when the server lists only steps it does not name", () => {
    const methodology = overview({
      research: { missing: ['something_new'], count: 0 }, prfaq: { missing: ['something_new'], count: 0 },
      prd: { missing: [], count: 0 }, prototype: { missing: [], count: 0, blocked: false },
    })
    const { steps } = deriveOverviewState({ personas: [persona('p1')], documents: [], methodology })
    expect(documentsHint(steps.documents, t)).toBe('Personas or research make these documents stronger.')
  })
})
