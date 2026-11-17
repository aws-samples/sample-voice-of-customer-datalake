/**
 * @fileoverview The run's Board (the run workspace's inspector tab since 7.51.00) and an agent's session facts.
 *
 * - An agent's facts: its session as the supervisor keeps it: its step, its MicroVM's state and age, its heartbeat's
 *   age and its last progress, its start, its MicroVM time and tokens per model (the inspector's Cost tab).
 * - Board: the tasks grouped by state, each with its lease holder and attempt, and its history in a disclosure; for an
 *   admin on a run under way, the board controls (EngineeringBoardControls.tsx).
 *
 * @module pages/Agents/EngineeringRunPanels
 */
import { useTranslation } from 'react-i18next'
import { formatDateTime, formatRelativeDate } from '../../utils/dateUtils'
import { TASK_STATES } from '../../api/engineeringRunsApi'
import { PostTaskForm, TaskControls } from './EngineeringBoardControls'
import { groupsInOrder, useAge } from './engineeringRunText'
import type { EngineeringAgent, EngineeringTask } from '../../api/engineeringRunsApi'

/** An epoch-seconds time as an age from `now` (ms), in the reader's words. */
const sinceEpoch = (seconds: number | null, language: string, now: number) =>
  formatRelativeDate(seconds === null ? null : new Date(seconds * 1000).toISOString(), language, now, '—')

/** An agent's session as the supervisor keeps it: its step, MicroVM, heartbeat, last progress, start and use. */
export function AgentFacts({ agent, now }: Readonly<{ agent: EngineeringAgent; now: number }>) {
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

/** Who may act on the board from here: the run, and the signed-in admin's `sub` (absent: no controls). */
interface BoardActor {
  runId: string
  me: string
}

function TaskItem({ task, actor }: Readonly<{ task: EngineeringTask; actor?: BoardActor }>) {
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
      {actor !== undefined && <TaskControls runId={actor.runId} task={task} me={actor.me} />}
    </li>
  )
}

/** The board by state; with `actor` (an admin, the run under way) its controls: post a task, act on each one. */
export function BoardPanel({ tasks, actor }: Readonly<{ tasks: readonly EngineeringTask[]; actor?: BoardActor }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-4">
      {actor !== undefined && <PostTaskForm runId={actor.runId} />}
      {tasks.length === 0 && <p className="text-sm text-muted">{t('engineeringRun.noTasks')}</p>}
      {groupsInOrder(TASK_STATES, tasks.map((task) => task.state)).map((state) => {
        const group = tasks.filter((task) => task.state === state)
        const name = t(`engineeringRun.states.${state}`, { defaultValue: state })
        return (
          <section key={state} aria-label={name} className="space-y-2">
            <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">{name} ({group.length})</h3>
            <ul className="space-y-2">{group.map((task) => <TaskItem key={task.task_id} task={task} actor={actor} />)}</ul>
          </section>
        )
      })}
    </div>
  )
}
