/**
 * @fileoverview The built-in "Reviews → Prototype" workflow can be built by
 * hand (owner request: "make sure you can build the standard workflow").
 *
 * Starting from a cleared canvas, the test adds every step through the same
 * model actions the palette and side panel use (`addNode`, `updateNode`,
 * `connect` with an explicit condition, `addToLoop`, `updateLoop`), then
 * compares the result with the server's template — semantics only: ids and
 * positions are free. `builtinWorkflow.json` is pinned to
 * `shared.workflow_schema.default_template()` by
 * `lambda/shared/test/test_workflow_builtin_fixture.py`.
 */
import { describe, it, expect } from 'vitest'
import builtinJson from '@test/builtinWorkflow.json'
import { normalizeDefinition } from '../../api/workflowsApi'
import { validateLocally } from './graphRules'
import { NODE_CATALOGUE, addNode, addToLoop, clearDefinition, connect, loopIndexOf, updateLoop, updateNode } from './model'
import { emptyDefinition } from './model-fixtures'
import type { WorkflowDefinition, WorkflowNode } from '../../api/workflowsApi'

function builtin(): WorkflowDefinition {
  const definition = normalizeDefinition(builtinJson)
  if (definition === null) throw new Error('builtinWorkflow.json is not a workflow')
  return definition
}

/** What a workflow MEANS: steps by title, arrows and loops by step titles; ids and positions dropped. */
function semantics(definition: WorkflowDefinition) {
  const title = (id: string) => definition.nodes.find((n) => n.id === id)?.data.title ?? `?${id}`
  const byText = (a: string, b: string) => a.localeCompare(b)
  return {
    name: definition.name,
    description: definition.description ?? '',
    steps: definition.nodes
      .map((n) => ({ type: n.type, title: n.data.title, role: n.data.role ?? null, instructions: n.data.instructions ?? '', params: n.data.params ?? {} }))
      .sort((a, b) => byText(a.title, b.title)),
    arrows: definition.edges.map((e) => `${title(e.source)} → ${title(e.target)} [${e.label ?? 'always'}]`).sort(byText),
    loops: definition.loops
      .map((l) => ({ steps: l.node_ids.map(title).sort(byText), until: l.until, max_rounds: l.max_rounds }))
      .sort((a, b) => byText(a.steps.join('|'), b.steps.join('|'))),
  }
}

/** One palette add plus the side panel's edits (title, role, instructions, params) for `node`. */
function addLike(definition: WorkflowDefinition, node: WorkflowNode): { definition: WorkflowDefinition; id: string } {
  const added = addNode(definition, node.type, { x: 0, y: 0 }, `New ${node.type}`)
  const edited = updateNode(added.definition, added.nodeId, (n) => {
    const { role, instructions, params } = node.data
    return {
      ...n,
      data: {
        title: node.data.title,
        ...(instructions === undefined ? {} : { instructions }),
        ...(role === undefined ? {} : { role }),
        params: params ?? {},
      },
    }
  })
  return { definition: edited, id: added.nodeId }
}

interface Draft {
  definition: WorkflowDefinition
  /** Built-in step id → the id the editor minted for its copy. */
  ids: ReadonlyMap<string, string>
}

const mappedId = (draft: Draft, id: string): string => draft.ids.get(id) ?? id

/** Palette + side panel: every step, in the template's order. */
function addSteps(target: WorkflowDefinition): Draft {
  const empty = { ...clearDefinition(emptyDefinition('scratch')), name: target.name, description: target.description }
  return target.nodes.reduce<Draft>((draft, node) => {
    const added = addLike(draft.definition, node)
    return { definition: added.definition, ids: new Map([...draft.ids, [node.id, added.id]]) }
  }, { definition: empty, ids: new Map() })
}

/** "Add arrow" with the template's condition (none = the default arrow). */
function addArrows(draft: Draft, target: WorkflowDefinition): Draft {
  const definition = target.edges.reduce((current, edge) => {
    const next = connect(current, mappedId(draft, edge.source), mappedId(draft, edge.target), edge.label ?? null)
    expect(next.edges, `arrow ${edge.id} was refused`).toHaveLength(current.edges.length + 1)
    return next
  }, draft.definition)
  return { ...draft, definition }
}

/** "Add to loop" (a new loop for the first member, that loop for the rest), then the loop's settings. */
function addLoops(draft: Draft, target: WorkflowDefinition): WorkflowDefinition {
  return target.loops.reduce((current, loop) => {
    const [first = '', ...rest] = loop.node_ids.map((id) => mappedId(draft, id))
    const opened = addToLoop(current, first, 'new')
    const index = loopIndexOf(opened, first)
    const filled = rest.reduce((acc, member) => addToLoop(acc, member, index), opened)
    return updateLoop(filled, index, { until: loop.until, max_rounds: loop.max_rounds })
  }, draft.definition)
}

function rebuild(target: WorkflowDefinition): WorkflowDefinition {
  return addLoops(addArrows(addSteps(target), target), target)
}

describe('rebuilding the built-in workflow by hand', () => {
  it('starts from an empty canvas', () => {
    const cleared = clearDefinition(builtin())
    expect([cleared.nodes, cleared.edges, cleared.loops]).toStrictEqual([[], [], []])
    expect(cleared.name).toBe(builtin().name)
  })

  it('produces the same workflow as the built-in template (ids and positions aside)', () => {
    const target = builtin()
    const rebuilt = rebuild(target)
    expect(semantics(rebuilt)).toStrictEqual(semantics(target))
    expect(validateLocally(rebuilt)).toStrictEqual([])
  })

  it('needs no role or param edits: the palette defaults are the built-in ones', () => {
    const nodes = builtin().nodes
    expect(nodes.map((n) => [n.id, NODE_CATALOGUE[n.type].role ?? null])).toStrictEqual(nodes.map((n) => [n.id, n.data.role ?? null]))
    // Review / revise targets and end statuses are per step (set in the panel); every other param is the default.
    const defaulted = nodes.filter((n) => !['persona_review', 'revise_document', 'end'].includes(n.type))
    expect(defaulted.map((n) => [n.id, NODE_CATALOGUE[n.type].params ?? {}])).toStrictEqual(defaulted.map((n) => [n.id, n.data.params ?? {}]))
  })

  it('uses every verdict condition and both loop settings the runtime supports', () => {
    const target = builtin()
    expect(new Set(target.edges.flatMap((e) => (e.label === undefined ? [] : [e.label])))).toStrictEqual(
      new Set(['agreed', 'not_agreed', 'pass', 'fail']),
    )
    expect(target.loops.map((l) => [l.until, l.max_rounds])).toStrictEqual([['persona_agreement', 3], ['persona_agreement', 2]])
  })
})
