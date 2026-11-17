/**
 * @fileoverview What the canvas draws besides steps (7.52.00 C2; docs/ux part 5 §5.3): the frame behind a loop group
 * (neutral now: a dashed `--control-border` container with a `bg-bg-hover` label pill; a loop is not AI, N16), the
 * frame a run draws behind a call's `<call>.<child>` steps (shaped like a call, two sheets behind it, with the child
 * flow, its revision and how many of its steps are done), and (7.51.00) a run's LANE: one task of a step and the agent
 * on it, a 16 px `aim` avatar with its role's glyph, its state's icon and outline at full strength, the open one
 * filled as selected (never a ring).
 *
 * @module components/WorkflowEditor/nodes/FrameNodes
 */
import { Circle, CircleCheck, CirclePause, CircleX, Hand, Loader2, Repeat, Square, Workflow } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { laneBorder } from '../runState'
import { roleGlyphName } from './nodeGlyphs'
import { GlyphIcon } from './GlyphIcon'
import type { NodeProps } from '@xyflow/react'
import type { LaneState } from '../runState'
import type { CallFrameFlowNode, LaneFlowNode, LoopFrameFlowNode } from './nodeData'

export function LoopFrameNode({ data, selected }: NodeProps<LoopFrameFlowNode>) {
  const { t } = useTranslation('agents')
  return (
    <div style={{ width: data.width, height: data.height }} data-testid={`loop-frame-${data.index}`}
      className={clsx('rounded-xl border border-dashed', selected ? 'border-solid border-accent bg-accent-subtle' : 'border-control-border')}>
      <span data-testid={`loop-frame-label-${data.index}`}
        className="voc-loop-frame-label m-2 inline-flex items-center gap-1 rounded-md bg-bg-hover px-1.5 py-0.5 text-[12px] font-medium text-text hover:text-text-strong">
        <Repeat size={12} aria-hidden="true" />
        {t('editor.loopFrame', { until: t(`loopUntil.${data.loop.until}`), n: data.loop.max_rounds })}
      </span>
    </div>
  )
}

/** A call's steps in a run, framed like the call they came from (its two sheets), with its flow and its progress. */
export function CallFrameNode({ data }: NodeProps<CallFrameFlowNode>) {
  return (
    <div style={{ width: data.width, height: data.height }} data-testid={`call-frame-${data.call}`}
      className="voc-node-call rounded-xl border border-dashed border-control-border">
      <span className="m-2 inline-flex items-center gap-1.5 rounded-md bg-bg-hover px-1.5 py-0.5 text-[12px] font-medium text-text">
        <Workflow size={12} aria-hidden="true" />
        <span>{data.label}</span>
        <span className="text-muted">· {data.progress}</span>
      </span>
    </div>
  )
}

function LaneIcon({ state }: Readonly<{ state: LaneState }>) {
  const { t } = useTranslation('agents')
  const label = t(`run.laneStates.${state}`)
  switch (state) {
    case 'running': return <Loader2 size={12} className="shrink-0 animate-spin text-accent-text" aria-label={label} />
    case 'ran_ok': return <CircleCheck size={12} className="shrink-0 text-ok" aria-label={label} />
    case 'ran_failed': return <CircleX size={12} className="shrink-0 text-danger" aria-label={label} />
    case 'waiting': return <Hand size={12} className="shrink-0 text-warn" aria-label={label} />
    case 'paused': return <CirclePause size={12} className="shrink-0 text-warn" aria-label={label} />
    case 'stopped': return <Square size={12} fill="currentColor" className="shrink-0 text-muted" aria-label={label} />
    case 'planned': return <Circle size={12} className="shrink-0 text-muted" aria-label={label} />
  }
}

/** The lane states whose outline is neutral, so a hover may paint it. */
const NEUTRAL_LANES: ReadonlySet<LaneState> = new Set(['stopped', 'planned'])

/** One lane of a run's stage: inert, a click opens its agent's session (the canvas never acts). */
export function LaneNode({ data }: NodeProps<LaneFlowNode>) {
  const { t } = useTranslation('agents')
  return (
    <div style={{ width: data.width, minHeight: data.height }} data-testid="run-lane" data-lane-state={data.state}
      data-open={data.open} className={clsx('flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] shadow-sm',
        laneBorder(data.state), data.open ? 'bg-accent-subtle' : 'bg-card',
        NEUTRAL_LANES.has(data.state) && 'hover:border-control-border-hover')}>
      <span aria-hidden="true" className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-aim-subtle text-aim">
        <GlyphIcon name={roleGlyphName(data.role)} size={10} />
      </span>
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
