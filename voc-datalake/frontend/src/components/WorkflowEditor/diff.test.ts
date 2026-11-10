/**
 * @fileoverview What one workflow definition adds, removes and changes
 * relative to another (the approval card's and the editor's diff).
 */
import { describe, it, expect } from 'vitest'
import { diffDefinitions, movedOnly } from './diff'
import { emptyDefinition } from './model-fixtures'
import type { WorkflowDefinition, WorkflowNode } from '../../api/workflowsApi'
import { at } from '@test/defined'

const prd: WorkflowNode = { id: 'prd', type: 'write_prd', position: { x: 0, y: 140 }, data: { title: 'PRD', role: 'worker' } }

function base(): WorkflowDefinition {
  const d = emptyDefinition('Flow')
  return {
    ...d,
    nodes: [...d.nodes, prd],
    edges: [{ id: 'e1', source: 'start', target: 'prd' }, { id: 'e2', source: 'prd', target: 'end' }],
  }
}

const mapNode = (d: WorkflowDefinition, id: string, fn: (n: WorkflowNode) => WorkflowNode): WorkflowDefinition =>
  ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? fn(n) : n)) })

describe('diffDefinitions', () => {
  it('reports identical definitions as unchanged', () => {
    const diff = diffDefinitions(base(), base())
    expect(diff.unchanged).toBe(true)
    expect(diff.nodes).toStrictEqual({ added: [], removed: [], changed: [] })
  })

  it('ignores key order and undefined fields', () => {
    const reordered = mapNode(base(), 'prd', (n) => ({ ...n, data: { role: 'worker', instructions: undefined, title: 'PRD' } }))
    expect(diffDefinitions(base(), reordered).unchanged).toBe(true)
  })

  it('treats missing params as empty params', () => {
    const withParams = mapNode(base(), 'prd', (n) => ({ ...n, data: { ...n.data, params: {} } }))
    expect(diffDefinitions(base(), withParams).unchanged).toBe(true)
  })

  it('lists added and removed nodes and edges, sorted', () => {
    const before = base()
    const after: WorkflowDefinition = {
      ...before,
      nodes: [...before.nodes.filter((n) => n.id !== 'prd'), { ...prd, id: 'zeta' }, { ...prd, id: 'alpha' }],
      edges: [{ id: 'e3', source: 'start', target: 'end' }],
    }
    const diff = diffDefinitions(before, after)
    expect(diff.nodes).toStrictEqual({ added: ['alpha', 'zeta'], removed: ['prd'], changed: [] })
    expect(diff.edges).toStrictEqual({ added: ['e3'], removed: ['e1', 'e2'], changed: [] })
    expect(diff.unchanged).toBe(false)
  })

  it('lists the changed fields of a node', () => {
    const after = mapNode(base(), 'prd', (n) => ({
      ...n, type: 'write_prfaq', data: { title: 'PR/FAQ', instructions: 'Short', params: { a: 1 } },
    }))
    expect(diffDefinitions(base(), after).nodes.changed).toStrictEqual([
      { id: 'prd', fields: ['type', 'title', 'instructions', 'role', 'params'] },
    ])
  })

  it('lists the changed fields of an edge', () => {
    const before = base()
    const after = { ...before, edges: [{ id: 'e1', source: 'start', target: 'end', label: 'pass' as const }, at(before.edges, 1)] }
    expect(diffDefinitions(before, after).edges.changed).toStrictEqual([{ id: 'e1', fields: ['target', 'label'] }])
  })

  it('reports loop changes regardless of member order', () => {
    const loop = { node_ids: ['prd', 'end'], until: 'review_pass' as const, max_rounds: 2 }
    const before = { ...base(), loops: [loop] }
    expect(diffDefinitions(before, { ...base(), loops: [{ ...loop, node_ids: ['end', 'prd'] }] }).loopsChanged).toBe(false)
    expect(diffDefinitions(before, { ...base(), loops: [{ ...loop, max_rounds: 3 }] }).loopsChanged).toBe(true)
    expect(diffDefinitions(before, base()).unchanged).toBe(false)
  })

  it('reports name and description changes', () => {
    const diff = diffDefinitions(base(), { ...base(), name: 'Renamed', description: 'Now described' })
    expect(diff.metaChanged).toStrictEqual(['name', 'description'])
    expect(diff.unchanged).toBe(false)
  })

  it('treats a missing "before" as everything added', () => {
    const diff = diffDefinitions(null, base())
    expect(diff.nodes.added).toStrictEqual(['end', 'prd', 'start'])
    expect(diff.edges.added).toStrictEqual(['e1', 'e2'])
    expect(diff.metaChanged).toStrictEqual(['name'])
  })
})

describe('movedOnly', () => {
  it('lists nodes whose only change is their position', () => {
    const moved = mapNode(base(), 'prd', (n) => ({ ...n, position: { x: 50, y: 140 } }))
    const movedAndRenamed = mapNode(moved, 'start', (n) => ({ ...n, position: { x: 9, y: 9 }, data: { ...n.data, title: 'Go' } }))
    const diff = diffDefinitions(base(), movedAndRenamed)
    expect(diff.nodes.changed).toStrictEqual([{ id: 'prd', fields: ['position'] }, { id: 'start', fields: ['position', 'title'] }])
    expect(movedOnly(diff)).toStrictEqual(['prd'])
  })

  it('is empty when nothing moved', () => {
    expect(movedOnly(diffDefinitions(base(), base()))).toStrictEqual([])
  })
})
