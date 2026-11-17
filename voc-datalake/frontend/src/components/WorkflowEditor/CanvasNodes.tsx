/**
 * @fileoverview The React Flow node renderers: a workflow step (card with
 * type icon, title, role, inline validation errors and — in the run graph —
 * its status: dashed while not run yet, a gate's pass or fail, and "you are
 * here" on the step the run is on), the frame drawn behind a loop group, and
 * (7.51.00) an engineering run's LANE: one task of a step and the agent on it,
 * a sibling of the step's other lanes under its card, with no edges (the run
 * workspace's canvas, pages/Agents/RunWorkspace/runLanes.ts).
 *
 * @module components/WorkflowEditor/CanvasNodes
 */
import { Handle, Position } from '@xyflow/react'
import { AlertTriangle, CheckCircle2, Circle, Loader2, MapPin, Repeat, ShieldCheck, ShieldX, Square, XCircle } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { NodeTypeIcon } from './NodeTypeIcon'
import { STEP_HEIGHT, STEP_WIDTH } from './model'
import { laneBorder } from './runState'
import type { Node, NodeProps } from '@xyflow/react'
import type { WorkflowLoop, WorkflowNode } from '../../api/workflowsApi'
import type { LaneState, StepState } from './runState'

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

type LaneData = {
  /** The agent on the task, else its role. */
  label: string
  role: string
  state: LaneState
  attempt: number
  /** The agent the workspace has open. */
  open: boolean
  width: number
  height: number
}
export type LaneFlowNode = Node<LaneData, 'lane'>

function RunBadge({ run }: Readonly<{ run: StepState }>) {
  const { t } = useTranslation('agents')
  const label = t(`run.stepStatus.${run.status}`)
  if (run.status === 'running') return <Loader2 size={13} className="animate-spin text-accent-text" aria-label={label} />
  if (run.status === 'done') return <CheckCircle2 size={13} className="text-ok" aria-label={label} />
  if (run.status === 'failed') return <XCircle size={13} className="text-danger" aria-label={label} />
  return null
}

/** The card's border / emphasis: selection, inline errors, run status (dashed: a step not run yet). */
function stepCardClass(selected: boolean, hasIssues: boolean, run: StepState | undefined): string {
  const here = run?.here === true ? ' ring-2 ring-accent ring-offset-2 ring-offset-bg-accent' : ''
  if (run?.status === 'failed') return `border-danger${here}`
  if (run?.status === 'running') return `border-accent${here}`
  if (hasIssues) return 'border-danger/60'
  if (selected) return 'border-accent'
  return run?.status === 'idle' ? 'border-dashed border-border opacity-60' : `border-border${here}`
}

/** A gate step's verdict, and the "you are here" mark of the step the run is on. */
function RunMarks({ run }: Readonly<{ run: StepState }>) {
  const { t } = useTranslation('agents')
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
      {run.gate === 'pass' && <span className="badge badge-ok"><ShieldCheck size={11} aria-hidden="true" /> {t('run.gate.pass')}</span>}
      {run.gate === 'fail' && <span className="badge badge-danger"><ShieldX size={11} aria-hidden="true" /> {t('run.gate.fail')}</span>}
      {run.here === true && <span className="inline-flex items-center gap-0.5 font-medium text-accent-text"><MapPin size={11} aria-hidden="true" /> {t('run.here')}</span>}
    </p>
  )
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
      {run !== undefined && (run.gate !== undefined || run.here === true) && <RunMarks run={run} />}
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

function LaneIcon({ state }: Readonly<{ state: LaneState }>) {
  const { t } = useTranslation('agents')
  const label = t(`run.laneStates.${state}`)
  switch (state) {
    case 'running': return <Loader2 size={12} className="shrink-0 animate-spin text-accent-text" aria-label={label} />
    case 'ran_ok': return <CheckCircle2 size={12} className="shrink-0 text-ok" aria-label={label} />
    case 'ran_failed': return <XCircle size={12} className="shrink-0 text-danger" aria-label={label} />
    case 'stopped': return <Square size={12} fill="currentColor" className="shrink-0 text-muted" aria-label={label} />
    case 'planned': return <Circle size={12} className="shrink-0 text-muted" aria-label={label} />
  }
}

/** One lane of a run's stage: inert, a click selects its agent (the canvas never acts). */
export function LaneNode({ data }: NodeProps<LaneFlowNode>) {
  const { t } = useTranslation('agents')
  return (
    <div style={{ width: data.width, minHeight: data.height }} data-testid="run-lane" data-lane-state={data.state}
      className={clsx('flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-[12px] shadow-sm', laneBorder(data.state),
        data.open && 'ring-2 ring-accent')}>
      <LaneIcon state={data.state} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono font-medium text-text-strong">{data.label}</span>
        <span className="block truncate text-[12px] text-muted">
          {data.attempt > 1 ? t('run.laneAttempt', { role: data.role, n: data.attempt }) : data.role}
        </span>
      </span>
    </div>
  )
}
