/**
 * @fileoverview The Trigger (Start) and End (End, Stop at PR) nodes: a pill, 180 × 44, with a neutral tile
 * (`CirclePlay`, `Flag`, `GitPullRequest`), the title and one line: "Starts the run" on Start, "Completed" on an End,
 * the pull request's state on a Stop at PR (Start's `pr` setting: ready for review, unless it says draft). Start has a
 * source only; an End and a Stop at PR a target only.
 *
 * @module components/WorkflowEditor/nodes/TerminalNode
 */
import { useTranslation } from 'react-i18next'
import { NodeFrame, NodeIssue, NodeLines, NodeTile } from './NodeParts'
import { isQuiet, useStateWords } from './nodeState'
import { terminalLine } from './nodeText'
import { useFlowLookups } from './nodeData'
import type { NodeProps } from '@xyflow/react'
import type { StepFlowNode } from './nodeData'

export function TerminalNode({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const { prState } = useFlowLookups()
  const { step, kind } = data
  const engineering = step.type === 'stop_at_pr' || prState !== null
  const line = engineering ? terminalLine(t, step, prState ?? 'ready') : undefined
  const state = useStateWords(data)
  return (
    <NodeFrame id={id} data={data} selected={selected} shape="voc-node-pill"
      description={[t(`canvas.kinds.${kind}`), line ?? '', state].filter((part) => part !== '').join(', ')}>
      <span className="flex h-full items-center gap-2 px-3 py-1">
        <NodeTile step={step} kind={kind} size={24} />
        <span className="min-w-0 flex-1">
          <NodeLines title={step.data.title} line={line} quiet={isQuiet(data)} />
          <NodeIssue issues={data.issues} />
        </span>
      </span>
    </NodeFrame>
  )
}
