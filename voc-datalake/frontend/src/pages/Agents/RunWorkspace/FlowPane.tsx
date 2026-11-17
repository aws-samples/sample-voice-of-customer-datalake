/**
 * @fileoverview The workspace's flow pane (7.51.00): the run's canvas (RunCanvas.tsx) or its timeline
 * (RunTimeline.tsx), switched by a toggle; both select a session on a click and act on nothing. (7.51.04) The canvas
 * shows the run's orchestrator as the run itself, a strip above its steps with its session's status (never a lane of
 * a step); the timeline gives it its own first row.
 *
 * @module pages/Agents/RunWorkspace/FlowPane
 */
import { useMemo, useState } from 'react'
import { Bot, ListTree, Workflow } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { RunCanvas } from './RunCanvas'
import { RunTimeline } from './RunTimeline'
import { buildTimeline } from './runTimelineModel'
import { runStepStates, useRunFlow } from './runFlow'
import { orchestratorOf, statusChipClass } from './agentStatus'
import type { EngineeringAgent, EngineeringOverview } from '../../../api/engineeringRunsApi'

type View = 'canvas' | 'timeline'

interface Props {
  overview: EngineeringOverview
  current: string | null
  onOpen: (agent: string) => void
}

/** The run's orchestrator on the canvas: the run itself, above its steps; a click opens its session. */
function OrchestratorStrip({ agent, current, onOpen }: Readonly<{ agent: EngineeringAgent } & Omit<Props, 'overview'>>) {
  const { t } = useTranslation('agents')
  return (
    <button type="button" onClick={() => onOpen(agent.agent)}
      className={clsx('flex w-full min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover',
        agent.agent === current && 'bg-accent-subtle')}>
      <Bot size={13} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="shrink-0 font-medium text-text-strong">{t('runWorkspace.orchestrator')}</span>
      <span className="min-w-0 truncate font-mono">{agent.agent}</span>
      <span className={clsx('shrink-0', statusChipClass(agent.status))}>
        {t(`engineeringRun.status.${agent.status}`, { defaultValue: agent.status })}
      </span>
      <span className={clsx('ml-auto shrink-0', agent.agent === current ? 'text-text' : 'text-muted')}>{t('runWorkspace.flow.openSession')}</span>
    </button>
  )
}

/** The canvas view: the orchestrator's strip over the run's flow (lines while it loads; said when there is none). */
function CanvasView({ overview, flow, current, onOpen }: Readonly<Props & { flow: ReturnType<typeof useRunFlow> }>) {
  const { t } = useTranslation('agents')
  const { definition, isError, isLoading } = flow
  const orchestrator = orchestratorOf(overview.agents)
  return (
    <>
      {orchestrator !== null && <OrchestratorStrip agent={orchestrator} current={current} onOpen={onOpen} />}
      {overview.run.flow !== '' && isLoading && <div className="skeleton min-h-0 flex-1" />}
      {!isLoading && (isError || definition === null) && <p className="p-4 text-sm text-muted">{t('engineeringRun.noFlow')}</p>}
      {definition !== null && (
        <div className="min-h-0 flex-1"><RunCanvas overview={overview} definition={definition} current={current} onOpen={onOpen} /></div>
      )}
    </>
  )
}

export function FlowPane({ overview, current, onOpen }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const [view, setView] = useState<View>('canvas')
  const flow = useRunFlow(overview.run)
  const { definition } = flow
  const timeline = useMemo(() => buildTimeline(overview, definition === null ? new Map() : runStepStates(overview, definition)),
    [overview, definition])
  const toggle = (id: View, Icon: typeof Workflow) => (
    <button type="button" aria-pressed={view === id} onClick={() => setView(id)}
      className={clsx('btn btn-secondary btn-sm', view === id && 'border-accent bg-accent-subtle text-accent-text')}>
      <Icon size={14} aria-hidden="true" /> {t(`runWorkspace.flow.${id}`)}
    </button>
  )
  return (
    <section className="card flex min-w-0 flex-col p-0" aria-label={t('engineeringRun.flow')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium text-text-strong">{t('engineeringRun.flow')}</h2>
        <span role="group" aria-label={t('runWorkspace.flow.view')} className="ml-auto flex gap-1">
          {toggle('canvas', Workflow)}
          {toggle('timeline', ListTree)}
        </span>
      </div>
      <div className="flex h-[min(34rem,70vh)] min-h-[18rem] flex-col overflow-hidden">
        {view === 'timeline' && <div className="h-full overflow-y-auto"><RunTimeline timeline={timeline} current={current} onOpen={onOpen} /></div>}
        {view === 'canvas' && <CanvasView overview={overview} flow={flow} current={current} onOpen={onOpen} />}
      </div>
    </section>
  )
}
