/**
 * @fileoverview The workspace's flow pane (7.51.00): the run's canvas (RunCanvas.tsx) or its timeline
 * (RunTimeline.tsx), switched by a toggle; both select a session on a click and act on nothing.
 *
 * @module pages/Agents/RunWorkspace/FlowPane
 */
import { useMemo, useState } from 'react'
import { ListTree, Workflow } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { RunCanvas } from './RunCanvas'
import { RunTimeline } from './RunTimeline'
import { buildTimeline } from './runTimelineModel'
import { runStepStates, useRunFlow } from './runFlow'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

type View = 'canvas' | 'timeline'

interface Props {
  overview: EngineeringOverview
  current: string | null
  onOpen: (agent: string) => void
}

export function FlowPane({ overview, current, onOpen }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const [view, setView] = useState<View>('canvas')
  const { definition, isError, isLoading } = useRunFlow(overview.run)
  const steps = useMemo(() => buildTimeline(overview, definition === null ? new Map() : runStepStates(overview, definition)),
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
      <div className="h-[28rem] min-h-0 sm:h-[34rem] overflow-hidden">
        {view === 'timeline' && <div className="h-full overflow-y-auto"><RunTimeline steps={steps} current={current} onOpen={onOpen} /></div>}
        {view === 'canvas' && overview.run.flow !== '' && isLoading && <div className="skeleton h-full" />}
        {view === 'canvas' && !isLoading && (isError || definition === null) && <p className="p-4 text-sm text-muted">{t('engineeringRun.noFlow')}</p>}
        {view === 'canvas' && definition !== null && <RunCanvas overview={overview} definition={definition} current={current} onOpen={onOpen} />}
      </div>
    </section>
  )
}
