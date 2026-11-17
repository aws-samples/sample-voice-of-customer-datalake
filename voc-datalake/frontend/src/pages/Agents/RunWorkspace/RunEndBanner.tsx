/**
 * @fileoverview The run workspace's banner for a run that stopped (7.51.04; its words are runEnd.ts's): at the top of
 * the workspace, for an admin, whenever the run waits for a person, failed or was stopped. It says what happened in
 * plain words, which agent and at which step, why (the supervisor's stored reason, else the agent's last word and its
 * last failed command's exit, with the end of its error output behind "Show details"; all redacted by the server),
 * what the run cost so far, and what to do next with the run's own controls, which it links to (its control bar, and
 * the failed agent's session); it acts on nothing itself.
 *
 * @module pages/Agents/RunWorkspace/RunEndBanner
 */
import { useId, useMemo } from 'react'
import clsx from 'clsx'
import { Hand, Square, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { runEnd } from './runEnd'
import { flowPointStep, runStepStates, useRunFlow } from './runFlow'
import { useDollars } from './useDollars'
import type { LucideIcon } from 'lucide-react'
import type { AgentLastExit, EngineeringOverview } from '../../../api/engineeringRunsApi'
import type { RunEnd, RunEndTone } from './runEnd'

const TONES: Readonly<Record<RunEndTone, { box: string; icon: LucideIcon; iconTone: string; title: string }>> = {
  danger: { box: 'border-danger/30 bg-danger-subtle', icon: XCircle, iconTone: 'text-danger', title: 'text-danger' },
  warn: { box: 'border-warn/30 bg-warn-subtle', icon: Hand, iconTone: 'text-warn', title: 'text-text-strong' },
  muted: { box: 'border-border bg-bg-hover', icon: Square, iconTone: 'fill-current text-muted', title: 'text-text-strong' },
}

/** The title of the step where the run stopped (as the canvas marks it), else the step its decision point names. */
function useStoppedStep(overview: EngineeringOverview): string | null {
  const { definition } = useRunFlow(overview.run)
  return useMemo(() => {
    if (definition === null) return null
    const here = [...runStepStates(overview, definition).entries()].find(([, state]) => state.here === 'stopped')?.[0]
    return definition.nodes.find((node) => node.id === here)?.data.title ?? null
  }, [overview, definition])
}

/** Its last failed command in one line. */
function exitLine(exit: AgentLastExit): { key: string; code?: number } {
  if (exit.timed_out) return { key: 'runWorkspace.end.timedOut' }
  return exit.exit_code === null ? { key: 'runWorkspace.end.exitNoCode' } : { key: 'runWorkspace.end.exitCode', code: exit.exit_code }
}

/** The last failed command whole: where the agent was, its exit, how long it ran, the end of its error output. */
function ExitDetails({ exit, step }: Readonly<{ exit: AgentLastExit; step: string | null }>) {
  const { t } = useTranslation('agents')
  const seconds = exit.duration_seconds
  const facts = [
    step === null ? null : { name: t('runWorkspace.end.detailStep'), value: step },
    { name: t('runWorkspace.end.detailExit'), value: exit.exit_code === null ? '—' : String(exit.exit_code) },
    seconds === null ? null : { name: t('runWorkspace.end.detailDuration'), value: t('runWorkspace.gate.duration', { seconds }) },
  ].filter((fact): fact is { name: string; value: string } => fact !== null)
  return (
    <details className="text-[13px]">
      <summary className="cursor-pointer font-medium text-text hover:text-text-strong">{t('runWorkspace.end.details')}</summary>
      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {facts.map(({ name, value }) => (
          <div key={name} className="contents"><dt className="font-medium">{name}</dt><dd className="font-mono break-all">{value}</dd></div>
        ))}
      </dl>
      <p className="mt-1.5 font-medium">{t('runWorkspace.end.stderr')}</p>
      {exit.stderr_tail === ''
        ? <p>{t('runWorkspace.end.noStderr')}</p>
        : <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-card p-2 text-[12px] whitespace-pre-wrap break-all">{exit.stderr_tail}</pre>}
    </details>
  )
}

/** Why it stopped: the reason in words, else its last command's exit, else that nothing says (its session may). */
function Why({ end }: Readonly<{ end: RunEnd }>) {
  const { t } = useTranslation('agents')
  if (end.status === 'stopped') return null
  const line = end.exit === null ? null : exitLine(end.exit)
  const said = end.reason ?? (line === null ? null : t(line.key, { code: line.code }))
  if (said === null && end.agent === null) return null
  return (
    <p className="break-words [overflow-wrap:anywhere]">
      <span className="font-medium">{t('runWorkspace.end.why')}</span> {said ?? t('runWorkspace.end.noReason')}
    </p>
  )
}

/** Who, where, and the cost so far, on one line. */
function Facts({ end, overview, step }: Readonly<{ end: RunEnd; overview: EngineeringOverview; step: string | null }>) {
  const { t } = useTranslation('agents')
  const usd = useDollars()
  const cost = overview.run.cost_usd ?? overview.run.manifest?.cost_usd ?? null
  const agentKey = end.orchestrator ? 'runWorkspace.end.agentOrchestrator' : 'runWorkspace.end.agent'
  const facts = [
    end.agent === null ? null : t(agentKey, { agent: end.agent.agent }),
    step === null ? null : t('runWorkspace.end.step', { step }),
    cost === null ? null : t('runWorkspace.end.cost', { cost: usd(cost) }),
  ].filter((fact): fact is string => fact !== null)
  if (facts.length === 0) return null
  return <p className="flex flex-wrap gap-x-3 gap-y-0.5">{facts.map((fact) => <span key={fact}>{fact}</span>)}</p>
}

interface Props {
  overview: EngineeringOverview
  /** The run's control bar (a focusable region): "Go to the run's controls" moves there. */
  controlsId: string
  onOpen: (agent: string) => void
}

export function RunEndBanner({ overview, controlsId, onOpen }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const headingId = useId()
  const end = runEnd(overview)
  const stoppedStep = useStoppedStep(overview)
  if (end === null) return null
  const step = stoppedStep ?? flowPointStep(overview.run.waiting_at)
  const tone = TONES[end.tone]
  const Icon = tone.icon
  return (
    <section aria-labelledby={headingId} data-tone={end.tone} className={clsx('flex items-start gap-3 rounded-lg border p-4 text-sm text-text', tone.box)}>
      <Icon size={18} className={clsx('mt-0.5 shrink-0', tone.iconTone)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <h2 id={headingId} className={clsx('text-base font-semibold', tone.title)}>
          {t(`runWorkspace.end.what.${end.what}`, { agent: end.agent?.agent ?? '', step: step ?? '' })}
        </h2>
        <Facts end={end} overview={overview} step={step} />
        <Why end={end} />
        {end.exit !== null && <ExitDetails exit={end.exit} step={end.agent?.step ?? null} />}
        <p>{t(`runWorkspace.end.next.${end.next}`)}</p>
        <div className="flex flex-wrap gap-2 pt-0.5">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => document.getElementById(controlsId)?.focus()}>
            {t('runWorkspace.end.toControls')}
          </button>
          {end.agent !== null && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { if (end.agent !== null) onOpen(end.agent.agent) }}>
              {t('runWorkspace.end.openSession', { agent: end.agent.agent })}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
