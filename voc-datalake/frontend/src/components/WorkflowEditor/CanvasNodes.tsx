/**
 * @fileoverview The React Flow node renderers: a workflow step (card with
 * type icon, title, role, inline validation errors and — in the run graph —
 * its status: dashed while not run yet, a gate's pass or fail, and "you are
 * here" on the step the run is on), the frame drawn behind a loop group, and
 * (7.51.00) an engineering run's LANE: one task of a step and the agent on it,
 * a sibling of the step's other lanes under its card, with no edges (the run
 * workspace's canvas, pages/Agents/RunWorkspace/runLanes.ts).
 *
 * (7.51.04, the state layers of UX part 5 N7, N8, N10, N11 where cheap; the
 * node redesign is 7.52 C) A run state has its own badge and outline at full
 * strength (a person to act, paused, stopped and skipped among them), a step
 * whose turn it is with nobody on it does not spin, "You are here" and
 * "Stopped here" are tags rather than a ring, the open lane has the selected
 * fill, a neutral outline answers a hover, and nothing is dimmed by opacity.
 *
 * @module components/WorkflowEditor/CanvasNodes
 */
import { Handle, Position } from '@xyflow/react'
import {
  AlertTriangle, CheckCircle2, Circle, CircleDot, CirclePause, Hand, Loader2, MapPin, Repeat, ShieldCheck, ShieldX,
  SkipForward, Square, XCircle,
} from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { NodeTypeIcon } from './NodeTypeIcon'
import { STEP_HEIGHT, STEP_WIDTH } from './model'
import { laneBorder } from './runState'
import type { LucideIcon } from 'lucide-react'
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

/** Each run state's corner badge (7.51.04, UX part 5 N7: waiting for a person, paused, stopped and skipped their own). */
const RUN_BADGES: Partial<Record<StepState['status'], { icon: LucideIcon; tone: string }>> = {
  running: { icon: Loader2, tone: 'animate-spin text-accent-text' },
  done: { icon: CheckCircle2, tone: 'text-ok' },
  failed: { icon: XCircle, tone: 'text-danger' },
  waiting: { icon: Hand, tone: 'text-warn' },
  paused: { icon: CirclePause, tone: 'text-warn' },
  stopped: { icon: Square, tone: 'fill-current text-muted' },
  skipped: { icon: SkipForward, tone: 'text-muted' },
}

function RunBadge({ run }: Readonly<{ run: StepState }>) {
  const { t } = useTranslation('agents')
  // (a step whose turn it is with nobody at work on it yet: no spinner)
  if (run.status === 'running' && run.spin === false) {
    return <CircleDot size={13} className="text-accent-text" aria-label={t('run.stepStatus.ready')} />
  }
  const badge = RUN_BADGES[run.status]
  if (badge === undefined) return null
  const { icon: Icon, tone } = badge
  return <Icon size={13} className={clsx('shrink-0', tone)} aria-label={t(`run.stepStatus.${run.status}`)} />
}

/** The outline a run state holds, its tone at full strength; dashed for a step not run yet, dotted for a way not
 * taken, never dimmed by opacity (7.51.04, UX part 5 N7, N11). "You are here" is a tag, not a ring (N8). */
const RUN_OUTLINES: Partial<Record<StepState['status'], string>> = {
  failed: 'border-danger', running: 'border-accent', waiting: 'border-warn', paused: 'border-dashed border-warn',
  idle: 'border-dashed border-border-strong', skipped: 'border-dotted border-border-strong',
}

/** The card's border / emphasis: run status, inline errors, selection; on a run graph, a hover on a neutral one. */
function stepCardClass(selected: boolean, hasIssues: boolean, run: StepState | undefined): string {
  const outline = run === undefined ? undefined : RUN_OUTLINES[run.status]
  if (outline !== undefined) return outline
  if (hasIssues) return 'border-danger/60'
  if (selected) return 'border-accent'
  return run === undefined ? 'border-border' : 'border-border hover:border-control-border-hover'
}

/** "Stopped here"'s tone: the state it stopped in (danger failed, warn at a person or held, muted stopped). */
const STOPPED_HERE: Partial<Record<StepState['status'], string>> = {
  failed: 'badge-danger', waiting: 'badge-warn', paused: 'badge-warn',
}

/** A gate step's verdict, and the step the run is on ("You are here") or where it stopped ("Stopped here: Failed"). */
function RunMarks({ run }: Readonly<{ run: StepState }>) {
  const { t } = useTranslation('agents')
  const tone = STOPPED_HERE[run.status]
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
      {run.gate === 'pass' && <span className="badge badge-ok"><ShieldCheck size={11} aria-hidden="true" /> {t('run.gate.pass')}</span>}
      {run.gate === 'fail' && <span className="badge badge-danger"><ShieldX size={11} aria-hidden="true" /> {t('run.gate.fail')}</span>}
      {run.here === 'on' && <span className="badge badge-accent"><MapPin size={11} aria-hidden="true" /> {t('run.here')}</span>}
      {run.here === 'stopped' && (
        <span className={clsx('badge', tone ?? 'badge-muted')}>
          <MapPin size={11} aria-hidden="true" />{' '}
          {tone === undefined ? t('run.stoppedHere') : t('run.stoppedHereAs', { state: t(`run.stepStatus.${run.status}`) })}
        </span>
      )}
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
        <p className={clsx('text-[13px] font-medium leading-snug line-clamp-2 flex-1',
          run?.status === 'idle' || run?.status === 'skipped' ? 'text-muted' : 'text-text-strong')}>{step.data.title}</p>
        {run !== undefined && <RunBadge run={run} />}
      </div>
      {run !== undefined && run.rounds > 1 && (
        <p className="mt-0.5 text-[11px] text-muted font-mono">{t('run.rounds', { n: run.rounds })}</p>
      )}
      {run !== undefined && (run.gate !== undefined || run.here !== undefined) && <RunMarks run={run} />}
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
    case 'waiting': return <Hand size={12} className="shrink-0 text-warn" aria-label={label} />
    case 'paused': return <CirclePause size={12} className="shrink-0 text-warn" aria-label={label} />
    case 'stopped': return <Square size={12} fill="currentColor" className="shrink-0 text-muted" aria-label={label} />
    case 'planned': return <Circle size={12} className="shrink-0 text-muted" aria-label={label} />
  }
}

/** The lane states whose outline is neutral, so a hover may paint it. */
const NEUTRAL_LANES: ReadonlySet<LaneState> = new Set(['stopped', 'planned'])

/** One lane of a run's stage: inert, a click selects its agent (the canvas never acts). The open one has the selected
 * fill, not a ring (7.51.04, UX part 5 N8: a ring is "you are here"'s no more, nor the state's outline). */
export function LaneNode({ data }: NodeProps<LaneFlowNode>) {
  const { t } = useTranslation('agents')
  return (
    <div style={{ width: data.width, minHeight: data.height }} data-testid="run-lane" data-lane-state={data.state}
      data-open={data.open} className={clsx('flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] shadow-sm',
        laneBorder(data.state), data.open ? 'bg-accent-subtle' : 'bg-card',
        NEUTRAL_LANES.has(data.state) && 'hover:border-control-border-hover')}>
      <LaneIcon state={data.state} />
      <span className="min-w-0 flex-1">
        <span className={clsx('block truncate font-mono font-medium', data.state === 'planned' ? 'text-muted' : 'text-text-strong')}>
          {data.label}
        </span>
        <span className={clsx('block truncate text-[12px]', data.open ? 'text-text' : 'text-muted')}>
          {data.attempt > 1 ? t('run.laneAttempt', { role: data.role, n: data.attempt }) : data.role}
        </span>
      </span>
    </div>
  )
}
