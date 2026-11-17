/**
 * @fileoverview The Platform step node (map, reduce, memory: the platform acts, no model): a square-cornered card,
 * 200 × 56, with a neutral tile (`Split`, `Combine`, `Database`), the title and its setting in words ("By package · at
 * most 50", "Reads the repository's memory · 10").
 *
 * @module components/WorkflowEditor/nodes/PlatformNode
 */
import { useTranslation } from 'react-i18next'
import { NodeFrame, NodeIssue, NodeLines, NodeTile } from './NodeParts'
import { isQuiet, useStateWords } from './nodeState'
import { platformLine } from './nodeText'
import type { NodeProps } from '@xyflow/react'
import type { StepFlowNode } from './nodeData'

export function PlatformNode({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const { step, kind } = data
  const line = platformLine(t, step)
  const state = useStateWords(data)
  return (
    <NodeFrame id={id} data={data} selected={selected} shape="voc-node-platform"
      description={[t('canvas.kinds.platform'), line, state].filter((part) => part !== '').join(', ')}>
      <span className="flex h-full items-center gap-2 px-3 py-1.5">
        <NodeTile step={step} kind={kind} size={24} />
        <span className="min-w-0 flex-1">
          <NodeLines title={step.data.title} line={line} quiet={isQuiet(data)} />
          <NodeIssue issues={data.issues} />
        </span>
      </span>
    </NodeFrame>
  )
}
