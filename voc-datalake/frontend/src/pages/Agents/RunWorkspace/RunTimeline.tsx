/**
 * @fileoverview The run's timeline (7.51.00), the canvas's other view (runTimelineModel.ts): one collapsible row per step
 * with its state and its agents' count, under it each agent with its state and its attempts, newest first. Steps are
 * open by default and a reader may fold a finished one away. A click on an agent opens its session; nothing here
 * acts on the run.
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/workflows/WorkflowRunTree.tsx`, Apache-2.0
 * (THIRD-PARTY-LICENSES.md).
 *
 * @module pages/Agents/RunWorkspace/RunTimeline
 */
import { useState } from 'react'
import clsx from 'clsx'
import { CheckCircle2, ChevronRight, Circle, Loader2, Square, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import type { TimelineState, TimelineStep } from './runTimelineModel'
import type { LaneState } from '../../../components/WorkflowEditor/runState'

const STEP_ICONS: Readonly<Record<TimelineState, { icon: LucideIcon; tone: string }>> = {
  running: { icon: Loader2, tone: 'animate-spin text-accent-text' }, ok: { icon: CheckCircle2, tone: 'text-ok' },
  failed: { icon: XCircle, tone: 'text-danger' }, stopped: { icon: Square, tone: 'text-muted' }, planned: { icon: Circle, tone: 'text-muted' },
}
const LANE_TO_STEP: Readonly<Record<LaneState, TimelineState>> = {
  running: 'running', ran_ok: 'ok', ran_failed: 'failed', stopped: 'stopped', planned: 'planned',
}

function StateIcon({ state }: Readonly<{ state: TimelineState }>) {
  const { t } = useTranslation('agents')
  const { icon: Icon, tone } = STEP_ICONS[state]
  return <Icon size={12} className={clsx('shrink-0', tone)} aria-label={t(`runWorkspace.timeline.states.${state}`)} />
}

interface Props {
  steps: readonly TimelineStep[]
  current: string | null
  onOpen: (agent: string) => void
}

export function RunTimeline({ steps, current, onOpen }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const toggle = (step: string) => {
    setFolded((before) => new Set(before.has(step) ? [...before].filter((id) => id !== step) : [...before, step]))
  }
  if (steps.length === 0) return <p className="p-3 text-sm text-muted">{t('runWorkspace.timeline.empty')}</p>
  return (
    <ol className="space-y-2 overflow-y-auto p-3" aria-label={t('runWorkspace.timeline.label')}>
      {steps.map((step) => {
        const open = !folded.has(step.step)
        return (
          <li key={step.step} className="rounded-md border border-border">
            <button type="button" aria-expanded={open} onClick={() => toggle(step.step)}
              className="flex w-full items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-left text-[12px] font-medium hover:bg-bg-hover">
              <ChevronRight size={12} aria-hidden="true" className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
              <StateIcon state={step.state} />
              <span className="min-w-0 flex-1 truncate">{step.step === '' ? t('runWorkspace.timeline.offFlow') : step.title}</span>
              <span className="shrink-0 text-[12px] text-muted">{t('runWorkspace.timeline.agents', { count: step.agents.length })}</span>
            </button>
            {open && step.agents.length > 0 && (
              <ul className="divide-y divide-border">
                {step.agents.map((agent) => (
                  <li key={agent.key} className="px-3 py-1.5 text-[12px]">
                    <button type="button" disabled={agent.agent === null} onClick={() => { if (agent.agent !== null) onOpen(agent.agent) }}
                      className={clsx('flex w-full items-center gap-2 text-left', agent.agent === current && 'font-semibold text-accent-text')}>
                      <StateIcon state={LANE_TO_STEP[agent.state]} />
                      <span className="truncate font-mono">{agent.label}</span>
                      {agent.role !== '' && <span className="truncate text-muted">· {agent.role}</span>}
                    </button>
                    <p className="pl-5 text-[12px] text-muted">
                      {agent.attempts.map((attempt, index) => t(index === 0 ? 'runWorkspace.timeline.attemptNow' : 'runWorkspace.timeline.attempt', { n: attempt })).join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}
