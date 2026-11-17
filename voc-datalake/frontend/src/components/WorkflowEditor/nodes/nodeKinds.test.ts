/**
 * @fileoverview The node language (7.52.00 C2; docs/ux part 5 §5.3): every node type has a kind and a size inside the
 * 220 px column, the decision preset (an `end` that needs a person) is a decision, the tile's tone says who acts, a
 * gate's GO and NO-GO are two source handles mapped to the arrow's label, the minimap is by kind or by state, and Tab
 * follows the flow.
 */
import { describe, expect, it } from 'vitest'
import { WORKFLOW_ALL_NODE_TYPES } from '@stream/assistant/tools/agent-limits'
import {
  KIND_OF_TYPE, NODE_COLUMN, drawnPosition, flowOrder, kindOf, kindSize, labelOfHandle, minimapClass, nodeSize, storedPosition,
  tileTone, verdictHandles,
} from './nodeKinds'
import { GLYPHS, glyphNameOf } from './nodeGlyphs'
import type { WorkflowNode } from '../../../api/workflowsApi'

const step = (id: string, type: WorkflowNode['type'], params: Record<string, unknown> = {}, y = 0): WorkflowNode =>
  ({ id, type, position: { x: 0, y }, data: { title: id, params } })

describe('kinds and sizes', () => {
  it.each(WORKFLOW_ALL_NODE_TYPES)('%s has a kind, a size inside the column and a glyph', (type) => {
    const size = nodeSize(step('s', type))
    expect(KIND_OF_TYPE[type]).toBeTypeOf('string')
    expect([size.width <= NODE_COLUMN && size.width > 0, size.height > 0]).toStrictEqual([true, true])
    expect(GLYPHS[glyphNameOf(step('s', type))]).toBeDefined()
  })

  it('reads an end that needs a person as a decision, a completed one as an end', () => {
    expect(kindOf(step('human', 'end', { status: 'needs_human' }))).toBe('decision')
    expect(kindOf(step('done', 'end', { status: 'completed' }))).toBe('end')
    expect([kindOf(step('g', 'quality_gate')), kindOf(step('c', 'call_flow')), kindOf(step('b', 'board'))]).toStrictEqual(['gate', 'call', 'team'])
  })

  it('tones the tile by who acts: a model aim, a person warn, the platform neutral, a gate strong', () => {
    expect([tileTone('agent'), tileTone('team'), tileTone('decision'), tileTone('platform'), tileTone('gate')])
      .toStrictEqual(['aim', 'aim', 'warn', 'neutral', 'strong'])
  })

  it('centres a narrower shape in its column, and stores the column back on a drag', () => {
    const start = { ...step('start', 'start'), position: { x: 40, y: 10 } }
    const drawn = drawnPosition(start)
    expect(drawn).toStrictEqual({ x: 40 + (NODE_COLUMN - kindSize('trigger').width) / 2, y: 10 })
    expect(storedPosition(start, drawn)).toStrictEqual({ x: 40, y: 10 })
  })
})

describe('verdict handles (owner decision N-D4)', () => {
  it('gives a gate GO and NO-GO, a persona review Agreed and Not agreed, any other step none', () => {
    expect(verdictHandles('quality_gate').map((handle) => [handle.label, handle.word])).toStrictEqual([['pass', 'go'], ['fail', 'noGo']])
    expect(verdictHandles('persona_review').map((handle) => handle.label)).toStrictEqual(['agreed', 'not_agreed'])
    expect(verdictHandles('agent')).toStrictEqual([])
  })

  it('maps the handle dragged from to the arrow label, and the plain handle to none', () => {
    expect([labelOfHandle('quality_gate', 'fail'), labelOfHandle('final_review', 'pass'), labelOfHandle('agent', null)])
      .toStrictEqual(['fail', 'pass', undefined])
  })
})

describe('the minimap and the flow order', () => {
  it('fills by kind while building and by state in a run, a selected node stroked', () => {
    expect(minimapClass('gate', undefined, false)).toBe('voc-mini-gate')
    expect(minimapClass('agent', { status: 'failed', rounds: 1 }, true)).toBe('voc-mini-failed voc-mini-selected')
    expect(minimapClass('agent', { status: 'paused', rounds: 1 }, false)).toBe('voc-mini-waiting')
  })

  it('orders steps by their distance from the start, then by place; an unreached step last', () => {
    const nodes = [step('end', 'end', {}, 300), step('lost', 'map', {}, 10), step('fix', 'agent', {}, 150), step('start', 'start')]
    const edges = [{ id: 'a', source: 'start', target: 'fix' }, { id: 'b', source: 'fix', target: 'end' }]
    expect(flowOrder({ nodes, edges }).map((node) => node.id)).toStrictEqual(['start', 'fix', 'end', 'lost'])
  })
})
