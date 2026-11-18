/**
 * @fileoverview The "Calls a flow" node (7.52.00 `call_flow`): a stacked card, two sheets at 4 and 8 px behind a
 * rounded 220 × 88 card (a shape, not elevation), with a neutral `Workflow` tile, the title, the child flow's name and
 * the revision it pins ("Issue triage · r2"), and its share. A run's copy is flat (its calls expanded at the start),
 * so in a run the call is the frame its `<call>.<child>` steps are drawn in (`CallFrameNode`).
 *
 * @module components/WorkflowEditor/nodes/CallFlowNode
 */
import { useTranslation } from 'react-i18next'
import { NodeChips, NodeFrame, NodeIssue, NodeLines, NodeTile } from './NodeParts'
import { isQuiet, useStateWords } from './nodeState'
import { callLine, nodeWords, shareChip } from './nodeText'
import { useFlowLookups } from './nodeData'
import type { NodeProps } from '@xyflow/react'
import type { StepFlowNode } from './nodeData'

export function CallFlowNode({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const { flows } = useFlowLookups()
  const { step, kind } = data
  const params = step.data.params ?? {}
  const line = callLine(t, params, flows)
  const share = shareChip(t, params)
  const state = useStateWords(data)
  return (
    <NodeFrame id={id} data={data} selected={selected} shape="voc-node-call"
      description={nodeWords([t('canvas.kinds.call'), line, share?.text ?? '', state])}>
      <span className="flex items-start gap-2 px-3 py-2">
        <NodeTile step={step} kind={kind} />
        <span className="min-w-0 flex-1">
          <NodeLines title={step.data.title} line={line} quiet={isQuiet(data)} />
          <NodeChips chips={share === undefined ? [] : [share]} />
          <NodeIssue issues={data.issues} />
        </span>
      </span>
    </NodeFrame>
  )
}
