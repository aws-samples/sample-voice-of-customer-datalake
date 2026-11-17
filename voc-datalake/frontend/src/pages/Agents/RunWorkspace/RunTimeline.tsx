/**
 * @fileoverview The run's timeline (7.51.00), the canvas's other view (runTimelineModel.ts): the run's orchestrator
 * first, in a row of its own (7.51.04: it is the run's, on no step), then one collapsible row per step with its state
 * and its agents' count, under it each agent with its state and its attempts, newest first. Steps are open by default
 * and a reader may fold a finished one away; a step with no agent folds nothing, so it has no chevron and says so
 * ("No agents yet", "Not started"). Only a step or agent at work spins, and only while the run is under way; where
 * the run stopped, the row says so ("Stopped here"). A click on an agent opens its session; nothing here acts on the
 * run.
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/workflows/WorkflowRunTree.tsx`, Apache-2.0
 * (THIRD-PARTY-LICENSES.md).
 *
 * @module pages/Agents/RunWorkspace/RunTimeline
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  CheckCircle2, ChevronRight, Circle, CircleDot, CirclePause, Hand, Loader2, MapPin, SkipForward, Square, XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { statusChipClass } from './agentStatus'
import type { LucideIcon } from 'lucide-react'
import type { Timeline, TimelineAgent, TimelineState, TimelineStep } from './runTimelineModel'
import type { LaneState } from '../../../components/WorkflowEditor/runState'

const STEP_ICONS: Readonly<Record<TimelineState, { icon: LucideIcon; tone: string }>> = {
  running: { icon: Loader2, tone: 'animate-spin text-accent-text' }, ready: { icon: CircleDot, tone: 'text-accent-text' },
  ok: { icon: CheckCircle2, tone: 'text-ok' }, failed: { icon: XCircle, tone: 'text-danger' },
  waiting: { icon: Hand, tone: 'text-warn' }, paused: { icon: CirclePause, tone: 'text-warn' },
  stopped: { icon: Square, tone: 'fill-current text-muted' }, skipped: { icon: SkipForward, tone: 'text-muted' },
  planned: { icon: Circle, tone: 'text-muted' },
}
const LANE_TO_STEP: Readonly<Record<LaneState, TimelineState>> = {
  running: 'running', ran_ok: 'ok', ran_failed: 'failed', waiting: 'waiting', paused: 'paused', stopped: 'stopped',
  planned: 'planned',
}
/** "Stopped here"'s tone, by the state the step stopped in. */
const STOPPED_TONES: Partial<Record<TimelineState, string>> = { failed: 'badge-danger', waiting: 'badge-warn', paused: 'badge-warn' }

function StateIcon({ state }: Readonly<{ state: TimelineState }>) {
  const { t } = useTranslation('agents')
  const { icon: Icon, tone } = STEP_ICONS[state]
  return <Icon size={12} className={clsx('shrink-0', tone)} aria-label={t(`runWorkspace.timeline.states.${state}`)} />
}

/** Where the run is, or stopped, on a step's row. */
function HereMark({ step }: Readonly<{ step: TimelineStep }>) {
  const { t } = useTranslation('agents')
  if (step.here === undefined) return null
  const stopped = step.here === 'stopped'
  return (
    <span className={clsx('badge shrink-0', stopped ? STOPPED_TONES[step.state] ?? 'badge-muted' : 'badge-accent')}>
      <MapPin size={11} aria-hidden="true" /> {t(stopped ? 'run.stoppedHere' : 'run.here')}
    </span>
  )
}

/** What a step with no agent says in place of its count. */
function noAgents(state: TimelineState): string {
  if (state === 'planned') return 'runWorkspace.timeline.notStarted'
  return ['running', 'ready', 'waiting', 'paused'].includes(state) ? 'runWorkspace.timeline.noAgentsYet' : 'runWorkspace.timeline.noAgents'
}

function Attempts({ attempts }: Readonly<{ attempts: readonly number[] }>) {
  const { t } = useTranslation('agents')
  return (
    <p className="pl-5 text-[12px] text-muted">
      {attempts.map((attempt, index) => t(index === 0 ? 'runWorkspace.timeline.attemptNow' : 'runWorkspace.timeline.attempt', { n: attempt })).join(' · ')}
    </p>
  )
}

/** The run's orchestrator, the timeline's first row: who, its session's status, its attempts; a click opens it. */
function OrchestratorRow({ orchestrator, current, onOpen }: Readonly<{
  orchestrator: NonNullable<Timeline['orchestrator']>; current: string | null; onOpen: (agent: string) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <li className="rounded-md border border-border bg-card px-3 py-1.5 text-[12px]">
      <button type="button" onClick={() => onOpen(orchestrator.key)}
        className={clsx('flex w-full min-w-0 items-center gap-2 text-left', orchestrator.key === current && 'font-semibold text-accent-text')}>
        <StateIcon state={LANE_TO_STEP[orchestrator.state]} />
        <span className="shrink-0 font-medium text-text-strong">{t('runWorkspace.orchestrator')}</span>
        <span className="min-w-0 truncate font-mono">{orchestrator.label}</span>
        <span className={clsx('ml-auto shrink-0', statusChipClass(orchestrator.status))}>
          {t(`engineeringRun.status.${orchestrator.status}`, { defaultValue: orchestrator.status })}
        </span>
      </button>
      <Attempts attempts={orchestrator.attempts} />
    </li>
  )
}

function AgentRow({ agent, current, onOpen }: Readonly<{ agent: TimelineAgent; current: string | null; onOpen: (agent: string) => void }>) {
  return (
    <li className="px-3 py-1.5 text-[12px]">
      <button type="button" disabled={agent.agent === null} onClick={() => { if (agent.agent !== null) onOpen(agent.agent) }}
        className={clsx('flex w-full items-center gap-2 text-left', agent.agent === current && 'font-semibold text-accent-text')}>
        <StateIcon state={LANE_TO_STEP[agent.state]} />
        <span className="truncate font-mono">{agent.label}</span>
        {agent.role !== '' && <span className="truncate text-muted">· {agent.role}</span>}
      </button>
      <Attempts attempts={agent.attempts} />
    </li>
  )
}

function StepRow({ step, open, onToggle, current, onOpen }: Readonly<{
  step: TimelineStep; open: boolean; onToggle: () => void; current: string | null; onOpen: (agent: string) => void
}>) {
  const { t } = useTranslation('agents')
  const title = <span className="min-w-0 flex-1 truncate">{step.step === '' ? t('runWorkspace.timeline.offFlow') : step.title}</span>
  const row = 'flex w-full items-center gap-2 bg-card px-3 py-1.5 text-left text-[12px] font-medium'
  if (step.agents.length === 0) {
    return (
      <li className="rounded-md border border-border">
        <div className={row}>
          <StateIcon state={step.state} />{title}<HereMark step={step} />
          <span className="shrink-0 text-[12px] font-normal text-muted">{t(noAgents(step.state))}</span>
        </div>
      </li>
    )
  }
  return (
    <li className="rounded-md border border-border">
      <button type="button" aria-expanded={open} onClick={onToggle} className={clsx(row, 'border-b border-border hover:bg-bg-hover')}>
        <ChevronRight size={12} aria-hidden="true" className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <StateIcon state={step.state} />{title}<HereMark step={step} />
        <span className="shrink-0 text-[12px] text-muted">{t('runWorkspace.timeline.agents', { count: step.agents.length })}</span>
      </button>
      {open && (
        <ul className="divide-y divide-border">
          {step.agents.map((agent) => <AgentRow key={agent.key} agent={agent} current={current} onOpen={onOpen} />)}
        </ul>
      )}
    </li>
  )
}

interface Props {
  timeline: Timeline
  current: string | null
  onOpen: (agent: string) => void
}

export function RunTimeline({ timeline, current, onOpen }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (step: string) => {
    setFolded((before) => new Set(before.has(step) ? [...before].filter((id) => id !== step) : [...before, step]))
  }
  const { orchestrator, steps } = timeline
  if (orchestrator === null && steps.length === 0) return <p className="p-3 text-sm text-muted">{t('runWorkspace.timeline.empty')}</p>
  return (
    <ol className="space-y-2 overflow-y-auto p-3" aria-label={t('runWorkspace.timeline.label')}>
      {orchestrator !== null && <OrchestratorRow orchestrator={orchestrator} current={current} onOpen={onOpen} />}
      {steps.map((step) => (
        <StepRow key={step.step} step={step} open={!folded.has(step.step)} onToggle={() => toggle(step.step)} current={current} onOpen={onOpen} />
      ))}
    </ol>
  )
}
