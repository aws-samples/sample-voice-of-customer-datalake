/**
 * @fileoverview The note a decision sends to the next revision: the ticked
 * objections with their persona, then the human's own instructions, capped
 * at the server's limit; and which objections start ticked.
 */
import { describe, it, expect } from 'vitest'
import { MAX_DECISION_NOTE_CHARS } from '../../api/agentRunDecision'
import { blockingKeys, buildDecisionNote, objectionsByPersona, objectionsOf } from './decisionNote'
import type { RunVerdict } from '../../api/agentRunDecision'

const VERDICTS: RunVerdict[] = [
  { name: 'Ana', score: 3, blocking: true, objections: ['No hotel rule.', 'Cap is vague.'] },
  { name: 'Ben', score: 4, blocking: false, objections: ['Gate calls are Spanish only.'] },
  { name: 'Cleo', score: 5, blocking: false, objections: [] },
]

describe('objectionsOf', () => {
  it('lists every objection with its persona and a stable key, in panel order', () => {
    expect(objectionsOf(VERDICTS)).toStrictEqual([
      { key: '0:0', persona: 'Ana', text: 'No hotel rule.', blocking: true },
      { key: '0:1', persona: 'Ana', text: 'Cap is vague.', blocking: true },
      { key: '1:0', persona: 'Ben', text: 'Gate calls are Spanish only.', blocking: false },
    ])
  })

  it('returns nothing for no verdicts', () => {
    expect(objectionsOf([])).toStrictEqual([])
  })
})

describe('objectionsByPersona', () => {
  it('gives one group per verdict with objections, even when two personas share a name', () => {
    const twins: RunVerdict[] = [...VERDICTS, { name: 'Ana', score: 2, blocking: false, objections: ['Too long.'] }]
    expect(objectionsByPersona(twins).map((g) => [g.persona, g.blocking, g.objections.map((o) => o.key)])).toStrictEqual([
      ['Ana', true, ['0:0', '0:1']], ['Ben', false, ['1:0']], ['Ana', false, ['3:0']],
    ])
  })
})

describe('blockingKeys', () => {
  it("ticks only a blocking persona's objections", () => {
    expect([...blockingKeys(objectionsOf(VERDICTS))]).toStrictEqual(['0:0', '0:1'])
  })
})

describe('buildDecisionNote', () => {
  const all = objectionsOf(VERDICTS)

  it('lists the ticked objections, then the instructions', () => {
    expect(buildDecisionNote([all[0], all[2]].filter((o) => o !== undefined), '  Pay hotels after 12 h.  ')).toBe(
      'Fix these objections:\n- Ana: No hotel rule.\n- Ben: Gate calls are Spanish only.\n\nPay hotels after 12 h.')
  })

  it('is only the instructions when nothing is ticked, and empty when both are', () => {
    expect(buildDecisionNote([], 'Drop the claim.')).toBe('Drop the claim.')
    expect(buildDecisionNote([], '   ')).toBe('')
  })

  it("is cut at the server's limit, keeping the objections that come first", () => {
    const note = buildDecisionNote(all, 'x'.repeat(MAX_DECISION_NOTE_CHARS))
    expect(note).toHaveLength(MAX_DECISION_NOTE_CHARS)
    expect(note.startsWith('Fix these objections:\n- Ana: No hotel rule.')).toBe(true)
  })
})
