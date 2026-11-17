/**
 * @fileoverview One of the supervisor's lines in a thread, in plain words (7.51.04; supervisorLines.ts reads it):
 * "Starting… · $0.00" for a tick's health, "coordinator-1 stopped unexpectedly and was restarted (attempt 2 of 3)",
 * "coordinator-1 failed 3 times; the run needs a person", each toned by meaning (danger a failure, warn a restart or
 * a wait, muted the rest), a run of the same health line shown once with how many times it was said, and the raw
 * text (every line of the run) behind "Details".
 *
 * @module pages/Agents/RunWorkspace/SupervisorLine
 */
import clsx from 'clsx'
import { Activity, AlertTriangle, Hourglass, RotateCcw, Square, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CRASH_TRIES } from './supervisorLines'
import { useDollars } from './useDollars'
import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import type { ThreadItem } from '../../../api/engineeringRunWorkspaceApi'
import type { SupervisorLine } from './supervisorLines'

const LOOKS: Readonly<Record<SupervisorLine['kind'], { icon: LucideIcon; tone: string }>> = {
  health: { icon: Activity, tone: 'text-muted' },
  restarted: { icon: RotateCcw, tone: 'text-warn' },
  continued: { icon: RotateCcw, tone: 'text-muted' },
  failedOut: { icon: XCircle, tone: 'text-danger' },
  couldNotStart: { icon: XCircle, tone: 'text-danger' },
  notAnswering: { icon: AlertTriangle, tone: 'text-warn' },
  noRoom: { icon: Hourglass, tone: 'text-warn' },
  stopped: { icon: Square, tone: 'text-muted' },
}

/** A status of the health line in words ("Starting…"); one the page does not know, as the supervisor names it. */
const statusWords = (t: TFunction<'agents'>, status: string) => t(`runWorkspace.thread.supervisor.status.${status}`, { defaultValue: status })

/** The health line's statuses: one agent's alone ("Starting…"), else each with its count ("At work: 2, Starting…: 1"). */
function healthWords(t: TFunction<'agents'>, counts: Extract<SupervisorLine, { kind: 'health' }>['counts']): string {
  const [only] = counts
  if (counts.length === 1 && only?.count === 1) return statusWords(t, only.status)
  return counts.map(({ status, count }) => t('runWorkspace.thread.supervisor.count', { status: statusWords(t, status), count })).join(', ')
}

/** The line in plain words. `orchestrator`: the run's (its failure sends the run to a person). */
function useWords(): (line: SupervisorLine, orchestrator: string | null) => string {
  const { t } = useTranslation('agents')
  const usd = useDollars()
  return (line, orchestrator) => {
    switch (line.kind) {
      case 'health': return t('runWorkspace.thread.supervisor.health', { states: healthWords(t, line.counts), cost: usd(line.costUsd) })
      case 'restarted':
        return line.attempt <= CRASH_TRIES
          ? t('runWorkspace.thread.supervisor.restarted', { agent: line.agent, n: line.attempt, max: CRASH_TRIES })
          : t('runWorkspace.thread.supervisor.restartedAgain', { agent: line.agent, n: line.attempt })
      case 'continued': return t('runWorkspace.thread.supervisor.continued', { agent: line.agent })
      case 'failedOut':
        return line.agent === orchestrator
          ? t('runWorkspace.thread.supervisor.failedOutRun', { agent: line.agent, n: line.times })
          : t('runWorkspace.thread.supervisor.failedOutTask', { agent: line.agent, n: line.times })
      case 'couldNotStart': return t('runWorkspace.thread.supervisor.couldNotStart', { agent: line.agent, reason: line.reason })
      case 'notAnswering': return t('runWorkspace.thread.supervisor.notAnswering', { agent: line.agent })
      case 'noRoom': return t('runWorkspace.thread.supervisor.noRoom', { agent: line.agent, n: line.times })
      case 'stopped': return t('runWorkspace.thread.supervisor.stopped', { n: line.sessions })
    }
  }
}

/** The line, the latest of `said` (every item it stands for, oldest first), and their raw text behind "Details". */
export function SupervisorLineView({ line, said, orchestrator }: Readonly<{
  line: SupervisorLine; said: readonly ThreadItem[]; orchestrator: string | null
}>) {
  const { t } = useTranslation('agents')
  const words = useWords()
  const { icon: Icon, tone } = LOOKS[line.kind]
  const failed = line.kind === 'health' && line.counts.some(({ status }) => status === 'failed' || status === 'crashed')
  return (
    <div className="text-[13px]">
      <p className={clsx('flex flex-wrap items-center gap-1.5', failed ? 'text-danger' : tone)}>
        <Icon size={13} className="shrink-0" aria-hidden="true" />
        <span className={clsx('min-w-0 break-words [overflow-wrap:anywhere]', tone === 'text-muted' && !failed && 'text-text')}>
          {words(line, orchestrator)}
        </span>
        {said.length > 1 && <span className="badge badge-muted">{t('runWorkspace.thread.supervisor.repeats', { count: said.length })}</span>}
      </p>
      <details className="pl-5 text-[12px]">
        <summary className="cursor-pointer text-muted hover:text-text">{t('runWorkspace.thread.supervisor.details')}</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] text-muted">{said.map((item) => item.text).join('\n')}</pre>
      </details>
    </div>
  )
}
