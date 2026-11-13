/**
 * @fileoverview An admin's board controls on the run monitor (`…/board/tasks…`, engineering/board/api.py PersonBoard):
 * post a task for a role, and on a task that has not ended take it, block it with a reason, change its priority, and
 * move on a task they hold. Ending another person's hold (taking it over, or blocking it) asks first and is sent with
 * `over`. A task goes to "needs a person" only by Block, which says why (no bare move there). The coordinate task is
 * the run coordinator's: it has no controls (signal the run instead). Each action's refusal says why (a task that
 * moved on since the page read it: reload).
 *
 * @module pages/Agents/EngineeringBoardControls
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { BOARD_CLAIMERS } from '../../components/WorkflowEditor/engineeringRules'
import { COORDINATE_TASK, FINAL_TASK_STATES, PERSON_PREFIX, TASK_MOVES } from '../../api/engineeringRunsApi'
import { useEngineeringPostTask, useEngineeringTaskAction } from './useEngineeringRun'
import { useActionError } from './engineeringRunText'
import type { BoardAction, EngineeringTask } from '../../api/engineeringRunsApi'

const MAX_TITLE = 200
const MAX_REASON = 200
/** Block is the one way to "needs a person": it says why. */
const BLOCKED = 'needs_human'

/** Whether a person may act on the task: not the run coordinator's, not ended. */
const actsOn = (task: EngineeringTask): boolean =>
  task.task_id !== COORDINATE_TASK && !FINAL_TASK_STATES.includes(task.state)

function ActionError({ action }: Readonly<{ action: { isError: boolean; error: unknown } }>) {
  const errorText = useActionError()
  return action.isError ? <p role="alert" className="text-[12px] text-danger">{errorText(action.error)}</p> : null
}

/** "Post a task": a role that claims tasks, a title, and what to do. */
export function PostTaskForm({ runId }: Readonly<{ runId: string }>) {
  const { t } = useTranslation('agents')
  const action = useEngineeringPostTask(runId)
  const ids = { role: useId(), title: useId(), what: useId() }
  const [role, setRole] = useState<string>(BOARD_CLAIMERS[0])
  const [title, setTitle] = useState('')
  const [what, setWhat] = useState('')
  const ready = title.trim() !== '' && what.trim() !== '' && !action.isPending
  const submit = () => action.mutate({ role, title: title.trim(), spec: { instructions: what.trim() } }, {
    onSuccess: ({ duplicate }) => { if (!duplicate) { setTitle(''); setWhat('') } },
  })
  return (
    <details className="rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer text-sm text-text-strong">{t('engineeringRun.board.post')}</summary>
      <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); if (ready) submit() }}>
        <div className="flex flex-wrap gap-2">
          <label htmlFor={ids.role} className="text-[12px] text-muted">{t('engineeringRun.board.role')}</label>
          <select id={ids.role} className="input input-sm w-auto" value={role} onChange={(event) => setRole(event.target.value)}>
            {BOARD_CLAIMERS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
        <label htmlFor={ids.title} className="block text-[12px] text-muted">{t('engineeringRun.board.title')}</label>
        <input id={ids.title} className="input input-sm w-full" value={title} maxLength={MAX_TITLE}
          onChange={(event) => setTitle(event.target.value)} />
        <label htmlFor={ids.what} className="block text-[12px] text-muted">{t('engineeringRun.board.instructions')}</label>
        <textarea id={ids.what} className="input w-full" rows={3} value={what} onChange={(event) => setWhat(event.target.value)} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!ready}>{t('engineeringRun.board.postSubmit')}</button>
        <ActionError action={action} />
        {action.isSuccess && (
          <p role="status" className="text-[12px] text-muted">
            {t(action.data.duplicate ? 'engineeringRun.board.duplicate' : 'engineeringRun.board.posted')}
          </p>
        )}
      </form>
    </details>
  )
}

/** Take (or Take over, from another person), or the moves of a task the admin holds (none to "needs a person"). */
function HolderButtons({ task, mine, anothers, busy, act, askOver }: Readonly<{
  task: EngineeringTask; mine: boolean; anothers: boolean; busy: boolean
  act: (request: BoardAction) => void; askOver: (request: BoardAction) => void
}>) {
  const { t } = useTranslation('agents')
  if (!mine) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
        onClick={() => (anothers ? askOver({ action: 'take', over: true }) : act({ action: 'take' }))}>
        {t(anothers ? 'engineeringRun.board.takeOver' : 'engineeringRun.board.take')}
      </button>
    )
  }
  return (
    <>
      {(TASK_MOVES[task.state] ?? []).filter((to) => to !== BLOCKED).map((to) => (
        <button key={to} type="button" className="btn btn-secondary btn-sm" disabled={busy}
          onClick={() => act({ action: 'move', to })}>
          {t('engineeringRun.board.moveTo', { state: t(`engineeringRun.states.${to}`, { defaultValue: to }) })}
        </button>
      ))}
    </>
  )
}

/** Block, with the reason it asks for. */
function BlockForm({ busy, onBlock }: Readonly<{ busy: boolean; onBlock: (reason: string) => void }>) {
  const { t } = useTranslation('agents')
  const reasonId = useId()
  const [reason, setReason] = useState('')
  return (
    <form className="flex flex-wrap items-center gap-1.5" onSubmit={(event) => {
      event.preventDefault()
      if (reason.trim() !== '') onBlock(reason.trim())
    }}>
      <label htmlFor={reasonId} className="text-[12px] text-muted">{t('engineeringRun.board.reason')}</label>
      <input id={reasonId} className="input input-sm min-w-0 flex-1" value={reason} maxLength={MAX_REASON}
        onChange={(event) => setReason(event.target.value)} />
      <button type="submit" className="btn btn-danger btn-sm" disabled={busy || reason.trim() === ''}>
        {t('engineeringRun.board.blockSubmit')}
      </button>
    </form>
  )
}

function Controls({ runId, task, me }: Readonly<{ runId: string; task: EngineeringTask; me: string }>) {
  const { t } = useTranslation('agents')
  const action = useEngineeringTaskAction(runId)
  const priorityId = useId()
  const [blocking, setBlocking] = useState(false)
  const [priority, setPriority] = useState(String(task.priority))
  // A take or block that ends another person's hold, waiting for the admin to confirm it.
  const [asking, setAsking] = useState<BoardAction | null>(null)
  const holder = task.lease?.agent ?? ''
  const mine = holder === `${PERSON_PREFIX}${me}`
  const anothers = holder.startsWith(PERSON_PREFIX) && !mine
  const name = task.title || task.task_id
  const act = (request: BoardAction) => action.mutate({ taskId: task.task_id, act: request })
  const number = priority.trim() === '' ? Number.NaN : Number(priority)
  const block = (reason: string) => (anothers ? setAsking({ action: 'block', reason, over: true }) : act({ action: 'block', reason }))
  return (
    <div className="space-y-1.5 pt-1">
      <div role="group" aria-label={t('engineeringRun.board.controls', { task: name })} className="flex flex-wrap items-center gap-1.5">
        <HolderButtons task={task} mine={mine} anothers={anothers} busy={action.isPending} act={act} askOver={setAsking} />
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={blocking} onClick={() => setBlocking(!blocking)}>
          {t('engineeringRun.board.block')}
        </button>
        <label htmlFor={priorityId} className="text-[12px] text-muted">{t('engineeringRun.board.priority')}</label>
        <input id={priorityId} type="number" className="input input-sm w-20" value={priority}
          onChange={(event) => setPriority(event.target.value)} />
        <button type="button" className="btn btn-ghost btn-sm"
          disabled={action.isPending || !Number.isInteger(number) || number === task.priority}
          onClick={() => act({ action: 'priority', priority: number })}>
          {t('engineeringRun.board.setPriority')}
        </button>
      </div>
      {blocking && <BlockForm busy={action.isPending} onBlock={block} />}
      <ActionError action={action} />
      <OverConfirm asking={asking} holder={holder.slice(PERSON_PREFIX.length)} busy={action.isPending}
        onCancel={() => setAsking(null)}
        onConfirm={(request) => { act(request); setAsking(null) }} />
    </div>
  )
}

/** Asks before a take or block ends another person's hold. */
function OverConfirm({ asking, holder, busy, onCancel, onConfirm }: Readonly<{
  asking: BoardAction | null; holder: string; busy: boolean; onCancel: () => void
  onConfirm: (request: BoardAction) => void
}>) {
  const { t } = useTranslation('agents')
  const words = asking?.action === 'block'
    ? { title: 'blockOverTitle', message: 'blockOverMessage', confirm: 'blockSubmit' }
    : { title: 'takeOverTitle', message: 'takeOverMessage', confirm: 'takeOver' }
  return (
    <ConfirmModal isOpen={asking !== null} title={t(`engineeringRun.board.${words.title}`)}
      message={t(`engineeringRun.board.${words.message}`, { holder })}
      confirmLabel={t(`engineeringRun.board.${words.confirm}`)} isLoading={busy}
      onCancel={onCancel}
      onConfirm={() => { if (asking !== null) onConfirm(asking) }} />
  )
}

/**
 * A task's controls: take (or take over), block, priority, and the moves of a task the admin holds; none on the
 * coordinator's task or a task that has ended.
 */
export function TaskControls(props: Readonly<{ runId: string; task: EngineeringTask; me: string }>) {
  // Keyed by the priority read: a change the board shows since (someone else's) starts the field from it.
  return actsOn(props.task) ? <Controls key={props.task.priority} {...props} /> : null
}
