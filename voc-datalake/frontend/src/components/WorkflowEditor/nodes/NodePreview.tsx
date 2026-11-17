/**
 * @fileoverview A step drawn exactly as the canvas draws it, at 1:1 and without handles (7.52.00 C2; docs/ux part 5
 * §5.5): the palette's drag preview (`setDragImage` of an off-screen, `aria-hidden` copy, so what you drag is the card
 * you get). It renders the kind's own renderer outside React Flow, with the lookups the canvas would give it.
 *
 * @module components/WorkflowEditor/nodes/NodePreview
 */
import { useMemo } from 'react'
import { FlowLookupsContext, useFlowLookups } from './nodeData'
import { kindOf } from './nodeKinds'
import { KIND_RENDERERS } from './nodeTypes'
import type { Ref } from 'react'
import type { WorkflowNode } from '../../../api/workflowsApi'

/** One step as a preview node (its kind's renderer; no handles, no state, not selected). */
export function NodePreview({ step, ref }: Readonly<{ step: WorkflowNode; ref?: Ref<HTMLDivElement> }>) {
  const outer = useFlowLookups()
  const lookups = useMemo(() => ({ ...outer, handles: false, descPrefix: 'preview' }), [outer])
  const kind = kindOf(step)
  const Renderer = KIND_RENDERERS[kind]
  return (
    <div ref={ref} aria-hidden="true" className="voc-workflow pointer-events-none fixed -left-[9999px] top-0">
      <FlowLookupsContext.Provider value={lookups}>
        <Renderer id={`preview-${step.id}`} data={{ step, kind, issues: [] }} type={kind} selected={false} dragging={false}
          zIndex={0} selectable={false} deletable={false} draggable={false} isConnectable={false}
          positionAbsoluteX={0} positionAbsoluteY={0} />
      </FlowLookupsContext.Provider>
    </div>
  )
}
