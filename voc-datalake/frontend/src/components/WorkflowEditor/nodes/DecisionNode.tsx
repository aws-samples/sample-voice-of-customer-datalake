/**
 * @fileoverview The Decision node, "A person decides" (an `end` that needs a person, where every NO-GO goes): a pill,
 * 200 × 52, with a `warn` diamond holding `Hand` at its start (the flowchart's decision, legible inside the 220 px
 * column: a true diamond holding two lines would need about 150 px each way), the title and "The run waits for a
 * person". Reached in a run: a 2 px warn outline and the corner's `Hand`, "Waiting for you".
 *
 * @module components/WorkflowEditor/nodes/DecisionNode
 */
import { Hand } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NodeBody, NodeFrame } from './NodeParts'
import { useStateWords } from './nodeState'
import { nodeWords } from './nodeText'
import type { NodeProps } from '@xyflow/react'
import type { StepFlowNode } from './nodeData'

export function DecisionNode({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const waiting = data.run?.status === 'waiting'
  const line = t(waiting ? 'canvas.decision.waiting' : 'canvas.decision.line')
  const state = useStateWords(data)
  return (
    <NodeFrame id={id} data={data} selected={selected} shape="voc-node-pill"
      description={nodeWords([t('canvas.kinds.decision'), line, state])}>
      <span className="flex h-full items-center gap-2.5 px-4 py-1.5">
        <span className="voc-node-diamond" aria-hidden="true"><Hand size={12} /></span>
        <NodeBody data={data} line={line} />
      </span>
    </NodeFrame>
  )
}
