/**
 * @fileoverview A run's calls, regrouped (7.52.00 C2; docs/ux part 5 §5.7 gap I): a run's copy of its flow is flat
 * (its calls expanded at the start, D52-4), so a call's steps are `<call>.<child>` steps of the copy. The overview's
 * `run.expansion` names each call step, the flow it ran and that flow's revision; this finds each call's steps (a
 * nested call's steps are its caller's too) and how many of them are done, for the canvas to frame them under their
 * call and the inspector to say "3 of 6 steps done".
 *
 * @module components/WorkflowEditor/callGroups
 */
import type { ExpansionRecord, WorkflowDefinition } from '../../api/workflowsApi'
import type { StepState } from './runState'

export interface CallGroup {
  /** The call step (the prefix of its children's ids). */
  readonly call: string
  readonly flow: string
  readonly revision: number
  /** Its `<call>.<child>` steps in the run's copy. */
  readonly nodeIds: readonly string[]
  readonly done: number
  readonly total: number
}

/** Each call's steps in the run's flat copy, outermost first; a call none of whose steps is in the copy is left out. */
export function callGroups(
  definition: Pick<WorkflowDefinition, 'nodes'>, expansion: readonly ExpansionRecord[],
  states: ReadonlyMap<string, StepState> | undefined,
): CallGroup[] {
  return [...expansion]
    .sort((a, b) => a.step.split('.').length - b.step.split('.').length || a.step.localeCompare(b.step))
    .flatMap((record) => {
      const nodeIds = definition.nodes.filter((node) => node.id.startsWith(`${record.step}.`)).map((node) => node.id)
      if (nodeIds.length === 0) return []
      const done = nodeIds.filter((id) => states?.get(id)?.status === 'done').length
      return [{ call: record.step, flow: record.flow, revision: record.revision, nodeIds, done, total: nodeIds.length }]
    })
}

/** The call a step of the run's copy came from (its innermost), or null for a step of the flow itself. */
export function callOfStep(stepId: string, groups: readonly CallGroup[]): CallGroup | null {
  return [...groups].reverse().find((group) => group.nodeIds.includes(stepId)) ?? null
}
