/**
 * @fileoverview Keeps the workflow canvas legible. Fitting a long workflow
 * (the built-in template has 18 steps) into a 520–640 px panel used to shrink
 * step text to a few pixels, so the fit is floored at {@link FIT_VIEW_OPTIONS}
 * `minZoom` and the user pans (minimap, controls) instead.
 *
 * When the floor applies — the whole graph does not fit — the canvas centres
 * on one step: the editor on the start, the run graph on the step that is
 * running (else the one that failed, else the last that finished).
 *
 * @module components/WorkflowEditor/canvasFocus
 */
import { useEffect, useRef } from 'react'
import { useNodesInitialized, useReactFlow } from '@xyflow/react'
import { STEP_HEIGHT, STEP_WIDTH } from './model'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { StepState } from './runState'

/** The canvas's fit: never below a readable zoom, never above 1:1. */
export const FIT_VIEW_OPTIONS = { padding: 0.15, minZoom: 0.6, maxZoom: 1 } as const

/** A fit at (or within rounding of) the floor did not show the whole graph. */
const ZOOM_EPSILON = 0.01

/** The step a run graph centres on: running, else failed, else the last one that finished. */
export function focusStepId(runStates: ReadonlyMap<string, StepState> | undefined): string | undefined {
  if (runStates === undefined) return undefined
  const entries = [...runStates.entries()]
  const byStatus = (status: StepState['status']) => entries.filter(([, state]) => state.status === status).map(([id]) => id)
  return byStatus('running').at(0) ?? byStatus('failed').at(0) ?? byStatus('done').at(-1)
}

/** The editor's focus: the workflow's start step. */
export function startStepId(definition: WorkflowDefinition): string | undefined {
  return definition.nodes.find((node) => node.type === 'start')?.id
}

/** True when a fit landed on the zoom floor, i.e. part of the graph is off-screen. */
export function fitHitFloor(zoom: number): boolean {
  return zoom <= FIT_VIEW_OPTIONS.minZoom + ZOOM_EPSILON
}

/**
 * Once React Flow has measured the steps: fit (floored), then — only when the
 * graph is larger than the panel — centre on `focusId` at the floored zoom.
 */
export function useFocusStep(definition: WorkflowDefinition, focusId: string | undefined): void {
  const { fitView, getZoom, setCenter } = useReactFlow()
  const initialized = useNodesInitialized()
  // Read at focus time: moving the focused step (a drag) must not re-fit the view.
  const latest = useRef(definition)
  useEffect(() => {
    latest.current = definition
  })
  useEffect(() => {
    if (!initialized || focusId === undefined) return undefined
    const run = { cancelled: false }
    void fitView(FIT_VIEW_OPTIONS).then(() => {
      const position = latest.current.nodes.find((node) => node.id === focusId)?.position
      const zoom = getZoom()
      if (run.cancelled || position === undefined || !fitHitFloor(zoom)) return
      void setCenter(position.x + STEP_WIDTH / 2, position.y + STEP_HEIGHT / 2, { zoom })
    })
    return () => { run.cancelled = true }
  }, [initialized, focusId, fitView, getZoom, setCenter])
}
