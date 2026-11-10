/**
 * @fileoverview The two React Flow node renderers: a workflow step (card with
 * type icon, title, role, inline validation errors and — in the run graph —
 * its status), and the frame drawn behind a loop group.
 *
 * @module components/WorkflowEditor/CanvasNodes
 */
import { Handle, Position } from '@xyflow/react'
import { AlertTriangle, CheckCircle2, Loader2, Repeat, XCircle } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { NodeTypeIcon } from './NodeTypeIcon'
import { STEP_HEIGHT, STEP_WIDTH } from './model'
import type { Node, NodeProps } from '@xyflow/react'
import type { WorkflowLoop, WorkflowNode } from '../../api/workflowsApi'
import type { StepState } from './runState'

type StepNodeData = {
  step: WorkflowNode
  issues: readonly string[]
  run?: StepState
}
export type StepFlowNode = Node<StepNodeData, 'step'>

type LoopFrameData = {
  loop: WorkflowLoop
  index: number
  width: number
  height: number
}
export type LoopFrameFlowNode = Node<LoopFrameData, 'loopFrame'>

function RunBadge({ run }: Readonly<{ run: StepState }>) {
  const { t } = useTranslation('agents')
  const label = t(`run.stepStatus.${run.status}`)
  if (run.status === 'running') return <Loader2 size={13} className="animate-spin text-accent-text" aria-label={label} />
  if (run.status === 'done') return <CheckCircle2 size={13} className="text-ok" aria-label={label} />
  if (run.status === 'failed') return <XCircle size={13} className="text-danger" aria-label={label} />
  return null
}

/** The card's border / emphasis: selection, inline errors, run status. */
function stepCardClass(selected: boolean, hasIssues: boolean, run: StepState | undefined): string {
  if (run?.status === 'failed') return 'border-danger'
  if (run?.status === 'running') return 'border-accent'
  if (hasIssues) return 'border-danger/60'
  if (selected) return 'border-accent'
  return run?.status === 'idle' ? 'border-border opacity-60' : 'border-border'
}

function StepIssues({ issues }: Readonly<{ issues: readonly string[] }>) {
  if (issues.length === 0) return null
  const more = issues.length > 1 ? ` (+${issues.length - 1})` : ''
  return (
    <p className="mt-1 flex items-start gap-1 text-[12px] text-danger" title={issues.join('\n')}>
      <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="line-clamp-2">{issues[0]}{more}</span>
    </p>
  )
}

function StepHeader({ step }: Readonly<{ step: WorkflowNode }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-muted-strong">
      <NodeTypeIcon type={step.type} size={12} />
      <span className="truncate">{t(`nodeTypes.${step.type}.label`)}</span>
      {step.data.role !== undefined && (
        <span className="ml-auto badge badge-muted normal-case tracking-normal">{t(`roles.${step.data.role}`)}</span>
      )}
    </div>
  )
}

export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const { t } = useTranslation('agents')
  const { step, issues, run } = data
  return (
    <div
      style={{ width: STEP_WIDTH, minHeight: STEP_HEIGHT }}
      className={clsx('rounded-lg border bg-card px-3 py-2 shadow-sm transition-colors', stepCardClass(selected, issues.length > 0, run))}
      data-testid={`step-${step.id}`}
    >
      {step.type !== 'start' && <Handle type="target" position={Position.Top} />}
      <StepHeader step={step} />
      <div className="mt-1 flex items-start gap-1.5">
        <p className="text-[13px] font-medium text-text-strong leading-snug line-clamp-2 flex-1">{step.data.title}</p>
        {run !== undefined && <RunBadge run={run} />}
      </div>
      {run !== undefined && run.rounds > 1 && (
        <p className="mt-0.5 text-[11px] text-muted font-mono">{t('run.rounds', { n: run.rounds })}</p>
      )}
      <StepIssues issues={issues} />
      {step.type !== 'end' && <Handle type="source" position={Position.Bottom} />}
    </div>
  )
}

export function LoopFrameNode({ data, selected }: NodeProps<LoopFrameFlowNode>) {
  const { t } = useTranslation('agents')
  return (
    <div
      style={{ width: data.width, height: data.height }}
      className={clsx(
        'rounded-xl border border-dashed bg-aim-subtle/40',
        selected ? 'border-aim border-solid' : 'border-aim/50',
      )}
      data-testid={`loop-frame-${data.index}`}
    >
      <span
        className="voc-loop-frame-label m-2 inline-flex items-center gap-1 rounded-md bg-bg-elevated px-1.5 py-0.5 text-[12px] font-medium text-aim hover:bg-bg-hover"
        data-testid={`loop-frame-label-${data.index}`}
        title={t('editor.loopFrameHint')}
      >
        <Repeat size={12} aria-hidden="true" />
        {t('editor.loopFrame', { until: t(`loopUntil.${data.loop.until}`), n: data.loop.max_rounds })}
      </span>
    </div>
  )
}
