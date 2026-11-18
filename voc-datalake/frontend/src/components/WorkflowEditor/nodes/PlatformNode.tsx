/**
 * @fileoverview The Platform step node (map, reduce, memory: the platform acts, no model): a square-cornered card,
 * 200 × 56, with a neutral tile (`Split`, `Combine`, `Database`), the title and its setting in words ("By package · at
 * most 50", "Reads the repository's memory · 10").
 *
 * @module components/WorkflowEditor/nodes/PlatformNode
 */
import { useTranslation } from 'react-i18next'
import { TiledNode } from './NodeParts'
import { useStateWords } from './nodeState'
import { nodeWords, platformLine } from './nodeText'
import type { NodeProps } from '@xyflow/react'
import type { StepFlowNode } from './nodeData'

export function PlatformNode({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const { step } = data
  const line = platformLine(t, step)
  const state = useStateWords(data)
  return (
    <TiledNode id={id} data={data} selected={selected} shape="voc-node-platform" padding="py-1.5"
      description={nodeWords([t('canvas.kinds.platform'), line, state])} line={line} />
  )
}
