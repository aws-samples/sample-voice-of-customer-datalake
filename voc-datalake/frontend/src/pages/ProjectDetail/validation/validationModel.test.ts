/**
 * The Validation tab's pure parts (7.68.00): the editors' rows to and from the wire, the card's language and the
 * decision prefill as the Decisions tab's deep link.
 */
import { describe, expect, it } from 'vitest'
import { draftFromParams } from '../decisions/decisionDraft'
import {
  cardLanguage, criteriaRows, decisionLink, newRow, parsedTarget, percent, rowsValid, taskRows, toCriteria, toTasks,
} from './validationModel'

describe('the criteria editor', () => {
  it('round-trips a saved criterion and sends a new one without an id', () => {
    const rows = [...criteriaRows([{ id: 'c00aa11', text: 'Quick', target: 4.5 }]), { ...newRow(), text: ' Clear ' }]
    expect(toCriteria(rows)).toStrictEqual([{ id: 'c00aa11', text: 'Quick', target: 4.5 }, { text: 'Clear' }])
  })

  it.each([['', undefined], ['4', 4], ['5', 5], ['0.5', undefined], ['6', undefined], ['x', undefined]])(
    'reads the target %j as %j', (value, target) => {
      expect(parsedTarget(value)).toBe(target)
    })

  it('saves only rows with text and a target the server takes', () => {
    expect(rowsValid([{ key: 'a', text: 'Quick', target: '' }], true)).toBe(true)
    expect(rowsValid([{ key: 'a', text: 'Quick', target: '9' }], true)).toBe(false)
    expect(rowsValid([{ key: 'a', text: ' ', target: '' }], false)).toBe(false)
    expect(rowsValid([], false)).toBe(false)
  })

  it('sends tasks as text with their ids', () => {
    expect(toTasks([...taskRows([{ id: 't00aa11', text: 'Pay' }]), { ...newRow(), text: 'Find' }])).toStrictEqual([
      { id: 't00aa11', text: 'Pay' }, { text: 'Find' }])
  })
})

describe('the rest', () => {
  it('writes the card in one of the nine languages, else English', () => {
    expect([cardLanguage('pt-BR'), cardLanguage('ja'), cardLanguage('it')]).toStrictEqual(['pt', 'ja', 'en'])
  })

  it('shows a rate as a whole percent', () => {
    expect([percent(0.6667), percent(null)]).toStrictEqual([67, null])
  })

  it('opens the Decisions tab with the report\'s decision, its report among the evidence', () => {
    const link = decisionLink('p1', { title: 'Decide', verdict: 'pursue', rationale: 'All met', success_metric: 'Quick',
      evidence: { document_ids: ['doc_r'], feedback_ids: ['f1'] } })
    expect(draftFromParams(new URLSearchParams(link.split('?')[1]))).toMatchObject({
      title: 'Decide', verdict: 'pursue', rationale: 'All met', successMetric: 'Quick', documentIds: ['doc_r'],
      feedbackIds: 'f1',
    })
  })
})
