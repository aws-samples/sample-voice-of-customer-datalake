/**
 * @fileoverview The Gate node: an elongated hexagon, 220 × 76 (owner decision N-D2), with a strong neutral tile and
 * `ShieldCheck` (a persona review's `MessagesSquare`), the title and its packs · rounds · reviewers. Two source
 * handles, GO and NO-GO (a persona review's Agreed and Not agreed), set an arrow's verdict by where you drag
 * (N-D4). In a run the tile's shield shows the verdict (`ShieldCheck` ok, `ShieldX` danger) beside the GO / NO-GO badge.
 *
 * @module components/WorkflowEditor/nodes/GateNode
 */
import { useTranslation } from 'react-i18next'
import { NodeFrame, NodeIssue, NodeLines, NodeTile } from './NodeParts'
import { isQuiet, useStateWords } from './nodeState'
import { VerdictBadge } from './NodeStateBadge'
import { gateLine } from './nodeText'
import type { NodeProps } from '@xyflow/react'
import type { TFunction } from 'i18next'
import type { StepFlowNode } from './nodeData'

const VERDICT_GLYPHS = {
  pass: { name: 'verdict:pass', tone: 'text-ok' },
  fail: { name: 'verdict:fail', tone: 'text-danger' },
}

/** A run gate's verdict in words, none before it reports one. */
function verdictWord(t: TFunction<'agents'>, gate: 'pass' | 'fail' | undefined): string {
  if (gate === undefined) return ''
  return t(gate === 'pass' ? 'canvas.gate.go' : 'canvas.gate.noGo')
}

export function GateNode({ id, data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const { step, kind, run } = data
  const line = step.type === 'quality_gate' ? gateLine(t, step.data.params ?? {}) : t(`nodeTypes.${step.type}.label`)
  const state = useStateWords(data)
  const verdict = verdictWord(t, run?.gate)
  return (
    <NodeFrame id={id} data={data} selected={selected} shape="voc-node-gate"
      description={[t('canvas.kinds.gate'), line, state, verdict].filter((part) => part !== '').join(', ')}>
      <span className="voc-node-body flex items-center gap-2 py-2">
        <NodeTile step={step} kind={kind} size={24} glyph={run?.gate === undefined ? undefined : VERDICT_GLYPHS[run.gate]} />
        <span className="min-w-0 flex-1">
          <NodeLines title={step.data.title} line={run?.gate === undefined ? line : undefined} quiet={isQuiet(data)} />
          {run?.gate !== undefined && <span className="mt-0.5 flex"><VerdictBadge run={run} /></span>}
          <NodeIssue issues={data.issues} />
        </span>
      </span>
    </NodeFrame>
  )
}
