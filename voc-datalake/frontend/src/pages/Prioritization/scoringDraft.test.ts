import { describe, expect, it } from 'vitest'
import { DEFAULT_AXES } from '../../api/prioritizationAxes'
import {
  addAxis, archiveAxis, canAddAxis, draftFromAxes, draftProblems, draftShares, moveAxis, restoreAxis, toAxisInputs, updateAxis,
} from './scoringDraft'
import { SCORING_TEMPLATE_IDS, applyTemplate } from './scoringTemplates'

/** A stand-in translator: every key reads back as itself, so wording is traceable. */
const t = (key: string) => `T(${key})`
const fresh = () => draftFromAxes(DEFAULT_AXES, t)
const ids = (draft: readonly { id: string | null; archived: boolean }[]) => draft.map((axis) => `${axis.id ?? 'new'}${axis.archived ? '·archived' : ''}`)

describe('draftFromAxes / toAxisInputs', () => {
  it('seeds a built-in with its translated name and sends null back when it is unchanged', () => {
    const [first] = toAxisInputs(fresh(), t)
    expect(first).toStrictEqual({
      id: 'impact', label: null, description: null, weight: 40, direction: 'higher_better', low_label: null, high_label: null, archived: false,
    })
  })

  it('sends a renamed built-in label and a new metric without an id', () => {
    const draft = updateAxis(addAxis(fresh(), 'k1'), 'impact', { label: '  Customer value ' })
    const inputs = toAxisInputs(updateAxis(draft, 'k1', { label: 'Reach' }), t)
    expect([inputs[0]?.label, Object.hasOwn(inputs[4] ?? {}, 'id'), inputs[4]?.label]).toStrictEqual(['Customer value', false, 'Reach'])
  })

  it('puts archived metrics after the active ones', () => {
    expect(ids(toAxisInputs(archiveAxis(fresh(), 'impact'), t).map((input) => ({ id: input.id ?? null, archived: input.archived }))))
      .toStrictEqual(['time_to_market', 'strategic_fit', 'confidence', 'impact·archived'])
  })
})

describe('draftProblems mirrors the PUT 400s', () => {
  it('accepts the default setup', () => {
    expect(draftProblems(fresh())).toStrictEqual([])
  })

  it('needs a name on every custom metric', () => {
    expect(draftProblems(addAxis(fresh(), 'k1'))).toStrictEqual(['missingName'])
  })

  it('needs at least one active metric and one weight above 0', () => {
    const allArchived = fresh().reduce((draft, axis) => archiveAxis(draft, axis.key), fresh())
    const zeroWeights = fresh().reduce((draft, axis) => updateAxis(draft, axis.key, { weight: 0 }), fresh())
    expect([draftProblems(allArchived), draftProblems(zeroWeights)]).toStrictEqual([['noActive'], ['noWeight']])
  })

  it('stops adding at 8 active metrics', () => {
    const eight = ['a', 'b', 'c', 'd'].reduce((draft, key) => updateAxis(addAxis(draft, key), key, { label: key }), fresh())
    expect([canAddAxis(eight), draftProblems(addAxis(eight, 'e'))]).toStrictEqual([false, ['missingName', 'tooManyActive']])
  })
})

describe('editing the draft', () => {
  it('clamps weights to 0–100 whole numbers', () => {
    const draft = updateAxis(updateAxis(fresh(), 'impact', { weight: 250.4 }), 'confidence', { weight: -3 })
    expect([draft[0]?.weight, draft[3]?.weight]).toStrictEqual([100, 0])
  })

  it('shows each active metric its live share', () => {
    expect(draftShares(archiveAxis(fresh(), 'impact'))).toStrictEqual({ time_to_market: 50, strategic_fit: 33, confidence: 17 })
  })

  it('moves among active metrics only, and not past either end', () => {
    const moved = moveAxis(fresh(), 'time_to_market', -1)
    expect([ids(moved), ids(moveAxis(moved, 'time_to_market', -1))]).toStrictEqual([
      ['time_to_market', 'impact', 'strategic_fit', 'confidence'], ['time_to_market', 'impact', 'strategic_fit', 'confidence'],
    ])
  })

  it('archives a stored metric (never deletes) and removes a never-saved one', () => {
    const draft = archiveAxis(archiveAxis(addAxis(fresh(), 'k1'), 'k1'), 'impact')
    expect([ids(draft), ids(restoreAxis(draft, 'impact'))]).toStrictEqual([
      ['impact·archived', 'time_to_market', 'strategic_fit', 'confidence'], ['impact', 'time_to_market', 'strategic_fit', 'confidence'],
    ])
  })
})

describe('applyTemplate', () => {
  it('RICE reuses impact and confidence, adds Reach and Effort, archives the rest', () => {
    const change = applyTemplate(fresh(), 'rice', t)
    expect(ids(change.draft)).toStrictEqual(['new', 'impact', 'confidence', 'new', 'time_to_market·archived', 'strategic_fit·archived'])
    expect(change.archived).toStrictEqual(['T(prioritization:scores.timeToMarket)', 'T(prioritization:scores.strategicFit)'])
  })

  it('sets the template weights and Effort as lower is better', () => {
    const { draft } = applyTemplate(fresh(), 'rice', t)
    expect(draft.filter((axis) => !axis.archived).map((axis) => [axis.weight, axis.direction])).toStrictEqual([
      [30, 'higher_better'], [30, 'higher_better'], [20, 'higher_better'], [20, 'lower_better'],
    ])
  })

  it('Current default restores the archived built-ins and archives the custom metrics', () => {
    const rice = applyTemplate(draftFromAxes(DEFAULT_AXES, t), 'rice', t).draft
    // As if saved: the server minted ids for the two new metrics.
    const saved = rice.map((axis) => (axis.id === null ? { ...axis, id: axis.key.replace('template-', ''), key: axis.key.replace('template-', '') } : axis))
    expect(ids(applyTemplate(saved, 'default', t).draft)).toStrictEqual(['impact', 'time_to_market', 'strategic_fit', 'confidence', 'reach·archived', 'effort·archived'])
  })

  it('every template yields a draft the save would accept', () => {
    expect(SCORING_TEMPLATE_IDS.map((id) => draftProblems(applyTemplate(fresh(), id, t).draft))).toStrictEqual([[], [], [], []])
  })
})
