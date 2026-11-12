/**
 * @fileoverview The run monitor's Agents and Board panels.
 *
 * - Agents: each agent's session as the supervisor keeps it: its role and status (and continuation), its step, its
 *   MicroVM's state and age, its heartbeat's age and its last progress, why it looks stuck (highlighted), its
 *   MicroVM time and tokens per model, and (Inspect) its recent tool calls. An admin signals an agent on its own
 *   task, at the attempt the board shows, while the agent holds it and the task is not over.
 * - Board: the tasks grouped by state, each with its lease holder and attempt, and its history in a disclosure.
 *
 * @module pages/Agents/EngineeringRunPanels
 */
import { useTranslation } from 'react-i18next'
import { formatDateTime, formatRelativeDate } from '../../utils/dateUtils'
import { FINAL_TASK_STATES, TASK_STATES } from '../../api/engineeringRunsApi'
import { EngineeringSignals } from './EngineeringSignals'
import { groupsInOrder, useAge } from './engineeringRunText'
import type { EngineeringAgent, EngineeringTask } from '../../api/engineeringRunsApi'

/**
 * The agent's own task (its session's `task_id`), when the agent still holds it on the board and it is not over: the
 * one a signal to this agent goes through, at the board's lease epoch. None otherwise (no signal buttons).
 */
function signalTask(agent: EngineeringAgent, tasks: readonly EngineeringTask[]): EngineeringTask | undefined {
  const task = tasks.find((candidate) => candidate.task_id === agent.task_id)
  if (task === undefined || task.lease?.agent !== agent.agent || FINAL_TASK_STATES.includes(task.state)) return undefined
  return task
}

/** An epoch-seconds time as an age from `now` (ms), in the reader's words. */
const sinceEpoch = (seconds: number | null, language: string, now: number) =>
  formatRelativeDate(seconds === null ? null : new Date(seconds * 1000).toISOString(), language, now, '—')

function AgentFacts({ agent, now }: Readonly<{ agent: EngineeringAgent; now: number }>) {
  const { t, i18n } = useTranslation('agents')
  const age = useAge()
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px]">
      <dt className="text-muted">{t('engineeringRun.agent.step')}</dt><dd className="break-words">{agent.step ?? '—'}</dd>
      <dt className="text-muted">{t('engineeringRun.agent.vm')}</dt>
      <dd>{agent.microvm_state ?? '—'}{agent.microvm_age !== null && ` · ${t('engineeringRun.agent.for', { age: age(agent.microvm_age) })}`}</dd>
      <dt className="text-muted">{t('engineeringRun.agent.heartbeat')}</dt>
      <dd>{agent.heartbeat_age === null ? '—' : t('engineeringRun.agent.ago', { age: age(agent.heartbeat_age) })}</dd>
      <dt className="text-muted">{t('engineeringRun.agent.progress')}</dt><dd>{sinceEpoch(agent.last_progress_at, i18n.language, now)}</dd>
      <dt className="text-muted">{t('engineeringRun.agent.started')}</dt><dd>{sinceEpoch(agent.started_at, i18n.language, now)}</dd>
      <dt className="text-muted">{t('engineeringRun.agent.metering')}</dt>
      <dd>
        {t('engineeringRun.agent.microvmTime', { seconds: agent.microvm_seconds })}
        {agent.tokens.map((row) => (
          <span key={row.model} className="block break-words">
            {t('engineeringRun.modelTokens', { model: row.model || '—', input: row.input_tokens, output: row.output_tokens })}
          </span>
        ))}
      </dd>
    </dl>
  )
}

function AgentCard({ runId, agent, task, isAdmin, now }: Readonly<{
  runId: string; agent: EngineeringAgent; task: EngineeringTask | undefined; isAdmin: boolean; now: number
}>) {
  const { t } = useTranslation('agents')
  const lease = task?.lease ?? null
  return (
    <li className="card space-y-2 min-w-0">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-text-strong font-mono break-all">{agent.agent}</span>
        <span className="badge badge-muted">{agent.role || '—'}</span>
        <span className="badge badge-info">{t(`engineeringRun.status.${agent.status}`, { defaultValue: agent.status })}</span>
        {agent.continuation > 0 && (
          <span className="text-[12px] text-muted">{t('engineeringRun.agent.continuation', { n: agent.continuation })}</span>
        )}
      </p>
      {agent.stuck_why !== null && (
        <p role="note" className="rounded-md bg-warn-subtle px-2 py-1 text-[12px] text-warn break-words">
          {t('engineeringRun.agent.stuck', { reason: agent.stuck_why })}
        </p>
      )}
      <AgentFacts agent={agent} now={now} />
      <details className="text-[12px]">
        <summary className="cursor-pointer text-muted">{t('engineeringRun.agent.inspect', { n: agent.recent_tools.length })}</summary>
        {agent.recent_tools.length === 0
          ? <p className="mt-1 text-muted">{t('engineeringRun.agent.noTools')}</p>
          : <ol className="mt-1 list-decimal pl-5 font-mono break-all">{agent.recent_tools.map((tool, i) => <li key={`${String(i)}-${tool}`}>{tool}</li>)}</ol>}
      </details>
      {isAdmin && task !== undefined && lease !== null && (
        <EngineeringSignals runId={runId} task={{ taskId: task.task_id, attempt: lease.epoch, agent: agent.agent }} />
      )}
    </li>
  )
}

/** `now`: when the overview was read (the ages are as of then, and move on with each read). */
export function AgentsPanel({ runId, agents, tasks, isAdmin, now }: Readonly<{
  runId: string; agents: readonly EngineeringAgent[]; tasks: readonly EngineeringTask[]; isAdmin: boolean; now: number
}>) {
  const { t } = useTranslation('agents')
  if (agents.length === 0) return <p className="text-sm text-muted">{t('engineeringRun.noAgents')}</p>
  return (
    <ul className="space-y-3">
      {agents.map((agent) => (
        <AgentCard key={agent.agent} runId={runId} agent={agent} task={signalTask(agent, tasks)} isAdmin={isAdmin} now={now} />
      ))}
    </ul>
  )
}

function TaskItem({ task }: Readonly<{ task: EngineeringTask }>) {
  const { t, i18n } = useTranslation('agents')
  return (
    <li className="rounded-md border border-border px-3 py-2 space-y-1 min-w-0">
      <p className="text-sm text-text break-words">{task.title || task.task_id}</p>
      <p className="text-[12px] text-muted">
        {t('engineeringRun.task.meta', { role: task.role || '—', attempt: task.attempt })}
        {task.lease !== null && ` · ${t('engineeringRun.task.heldBy', { agent: task.lease.agent })}`}
      </p>
      {task.history.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-muted">{t('engineeringRun.task.history', { n: task.history.length })}</summary>
          <ol className="mt-1 space-y-0.5">
            {task.history.map((move) => (
              <li key={`${move.at}-${move.state}`} className="break-words">
                {t('engineeringRun.task.move', {
                  state: t(`engineeringRun.states.${move.state}`, { defaultValue: move.state }), by: move.by,
                  when: formatDateTime(move.at, i18n.language, '—'), attempt: move.attempt,
                })}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  )
}

export function BoardPanel({ tasks }: Readonly<{ tasks: readonly EngineeringTask[] }>) {
  const { t } = useTranslation('agents')
  if (tasks.length === 0) return <p className="text-sm text-muted">{t('engineeringRun.noTasks')}</p>
  return (
    <div className="space-y-4">
      {groupsInOrder(TASK_STATES, tasks.map((task) => task.state)).map((state) => {
        const group = tasks.filter((task) => task.state === state)
        const name = t(`engineeringRun.states.${state}`, { defaultValue: state })
        return (
          <section key={state} aria-label={name} className="space-y-2">
            <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{name} ({group.length})</h3>
            <ul className="space-y-2">{group.map((task) => <TaskItem key={task.task_id} task={task} />)}</ul>
          </section>
        )
      })}
    </div>
  )
}
