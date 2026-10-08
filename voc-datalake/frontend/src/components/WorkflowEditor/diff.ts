/**
 * @fileoverview What one workflow definition adds, removes and changes
 * relative to another — a port of `diff_definitions` in
 * `lambda/shared/workflow_schema.py` (same fields, same `position` rule), used
 * by the `update_workflow` approval card and the editor's unsaved-changes hint.
 *
 * @module components/WorkflowEditor/diff
 */
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../../api/workflowsApi'

type NodeField = 'type' | 'position' | 'title' | 'instructions' | 'role' | 'params'
type EdgeField = 'source' | 'target' | 'label'

interface ItemDiff<F extends string> {
  added: string[]
  removed: string[]
  changed: { id: string; fields: F[] }[]
}

export interface WorkflowDiff {
  nodes: ItemDiff<NodeField>
  edges: ItemDiff<EdgeField>
  loopsChanged: boolean
  metaChanged: ('name' | 'description')[]
  unchanged: boolean
}

const NODE_FIELDS: readonly [NodeField, (n: WorkflowNode) => unknown][] = [
  ['type', (n) => n.type],
  ['position', (n) => n.position],
  ['title', (n) => n.data.title],
  ['instructions', (n) => n.data.instructions],
  ['role', (n) => n.data.role],
  ['params', (n) => n.data.params ?? {}],
]
const EDGE_FIELDS: readonly [EdgeField, (e: WorkflowEdge) => unknown][] = [
  ['source', (e) => e.source],
  ['target', (e) => e.target],
  ['label', (e) => e.label],
]

/** Order-insensitive JSON equality for plain values. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
    return `{${fields.join(',')}}`
  }
  return JSON.stringify(value ?? null)
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b)
const byText = (a: string, b: string) => a.localeCompare(b)

function diffItems<T extends { id: string }, F extends string>(
  before: readonly T[], after: readonly T[], fields: readonly [F, (item: T) => unknown][],
): ItemDiff<F> {
  const b = new Map(before.map((i) => [i.id, i]))
  const a = new Map(after.map((i) => [i.id, i]))
  const changed: { id: string; fields: F[] }[] = []
  for (const id of [...b.keys()].filter((k) => a.has(k)).sort(byText)) {
    const prev = b.get(id)
    const next = a.get(id)
    if (prev === undefined || next === undefined) continue
    const names = fields.filter(([, read]) => !same(read(prev), read(next))).map(([name]) => name)
    if (names.length > 0) changed.push({ id, fields: names })
  }
  return {
    added: [...a.keys()].filter((k) => !b.has(k)).sort(byText),
    removed: [...b.keys()].filter((k) => !a.has(k)).sort(byText),
    changed,
  }
}

const loopKeys = (d: WorkflowDefinition | null) =>
  (d?.loops ?? []).map((l) => stable([[...l.node_ids].sort(byText), l.until, l.max_rounds])).sort(byText)

export function diffDefinitions(before: WorkflowDefinition | null, after: WorkflowDefinition): WorkflowDiff {
  const nodes = diffItems(before?.nodes ?? [], after.nodes, NODE_FIELDS)
  const edges = diffItems(before?.edges ?? [], after.edges, EDGE_FIELDS)
  const loopsChanged = !same(loopKeys(before), loopKeys(after))
  const metaChanged = (['name', 'description'] as const).filter((k) => (before?.[k] ?? '') !== (after[k] ?? ''))
  const any = (d: ItemDiff<string>) => d.added.length + d.removed.length + d.changed.length > 0
  return {
    nodes, edges, loopsChanged, metaChanged,
    unchanged: !(loopsChanged || metaChanged.length > 0 || any(nodes) || any(edges)),
  }
}

/** Changed nodes whose ONLY change is a move (hidden by default in a preview). */
export function movedOnly(diff: WorkflowDiff): string[] {
  return diff.nodes.changed.filter((c) => c.fields.length === 1 && c.fields[0] === 'position').map((c) => c.id)
}
