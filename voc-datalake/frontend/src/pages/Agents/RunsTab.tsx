/**
 * @fileoverview Runs tab: the agent's runs (newest first), and for the
 * selected run its read-only graph lit by the event journal, the event log
 * (with links into the project), Cancel, plus "Run now" for admins (it asks
 * first, RunNowConfirm). The graph
 * is deliberately not a control surface — only the explicit buttons act.
 *
 * @module pages/Agents/RunsTab
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, Play, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDateTime, formatTime } from '../../utils/dateUtils'
import { isActiveRun } from '../../api/agentsApi'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { useLabelKnownIds, useProjectName } from '../../hooks/useLabelKnownIds'
import { humanizeId } from '../../utils/displayLabels'
import { DEFAULT_WORKFLOW_ID, workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { WorkflowCanvas } from '../../components/WorkflowEditor/WorkflowCanvas'
import { NodeTypeIcon } from '../../components/WorkflowEditor/NodeTypeIcon'
import { stepStates } from '../../components/WorkflowEditor/runState'
import { RunStatusBadge } from './AgentBadges'
import { RunDecisionCard } from './RunDecisionCard'
import { RunNowConfirm } from './RunNowConfirm'
import { RunSummaryCard } from './RunSummaryCard'
import { useAgentMutations, useAgentRun, useAgentRuns, useRunEvents } from './useAgents'
import type { Agent, AgentRun, RunEvent } from '../../api/agentsApi'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { failedReads, type FailedReads } from '../../utils/failedReads'

/** When a run started, in the reader's language; "—" when unknown. */
const when = (iso: string | null, language: string) => formatDateTime(iso, language, '—')

/**
 * Why a failed run failed, when its summary does not already say: the last
 * failed step's journal line (runs from before the summary named the reason).
 */
function failureReasonOf(run: Pick<AgentRun, 'status' | 'error'>, events: readonly RunEvent[]): string | null {
  if (run.status !== 'failed' || run.error === null) return null
  const reason = events.filter((e) => e.kind === 'node_failed').at(-1)?.summary.trim() ?? ''
  return reason === '' || run.error.includes(reason) ? null : reason
}

function EventRef({ event }: Readonly<{ event: RunEvent }>) {
  const { t } = useTranslation('agents')
  const projectName = useProjectName()
  const projectId = event.ref?.project_id
  if (projectId === undefined) return null
  return (
    <Link className="text-[12px] link" to={`/projects/${encodeURIComponent(projectId)}`}>
      {t('run.openNamedProject', { name: projectName(projectId) })}
    </Link>
  )
}

function EventItem({ event, node }: Readonly<{ event: RunEvent; node: WorkflowDefinition['nodes'][number] | undefined }>) {
  const { t, i18n } = useTranslation('agents')
  const labelIds = useLabelKnownIds()
  return (
    <li className="flex gap-2 text-sm">
      <span className="font-mono text-[11px] text-muted-strong w-10 shrink-0 pt-0.5">#{event.seq}</span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <span className="badge badge-muted">{t(`run.eventKinds.${event.kind}`)}</span>
          {node !== undefined && <span className="inline-flex items-center gap-1"><NodeTypeIcon type={node.type} size={12} />{node.data.title}</span>}
          {event.role !== undefined && <span>· {t(`roles.${event.role}`, { defaultValue: humanizeId(event.role) })}</span>}
          <span>· {formatTime(event.at, i18n.language)}</span>
        </p>
        <p className="text-text whitespace-pre-wrap break-words">{labelIds(event.summary)}</p>
        {/* The technical reason behind a plain failure line (this log is the technical view). */}
        {event.detail !== undefined && event.detail !== '' && (
          <p className="font-mono text-[11px] text-muted whitespace-pre-wrap break-words">{event.detail}</p>
        )}
        <EventRef event={event} />
      </div>
    </li>
  )
}

function EventLog({ events, definition, focus, onClearFocus }: Readonly<{
  events: readonly RunEvent[]; definition: WorkflowDefinition | null; focus: string | null; onClearFocus: () => void
}>) {
  const { t } = useTranslation('agents')
  const nodes = new Map((definition?.nodes ?? []).map((n) => [n.id, n]))
  const shown = focus === null ? events : events.filter((e) => e.node_id === focus)
  return (
    <section aria-label={t('run.eventLog')} className="card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-text-strong mr-auto">{t('run.eventLog')}</p>
        {focus !== null && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClearFocus}>
            {t('run.showAll', { step: nodes.get(focus)?.data.title ?? focus })}
          </button>
        )}
      </div>
      {shown.length === 0 && <p className="text-[12px] text-muted">{t('run.noEvents')}</p>}
      {/* Scrolls, so it is focusable (keyboard scrolling; axe scrollable-region-focusable, E2E s2 F6). */}
      <ol tabIndex={0} aria-label={t('run.eventLog')} className="space-y-1.5 max-h-[420px] overflow-y-auto focus-ring" aria-live="polite">
        {shown.map((event) => (
          <EventItem key={event.seq} event={event} node={event.node_id === undefined ? undefined : nodes.get(event.node_id)} />
        ))}
      </ol>
    </section>
  )
}

function RunDetail({ agent, runId, canControl, technical, onToggleTechnical }: Readonly<{
  agent: Agent; runId: string; canControl: boolean
  /** The step graph and event log are open (kept across the runs the user picks). */
  technical: boolean; onToggleTechnical: () => void
}>) {
  const { data: run } = useAgentRun(agent.agent_id, runId)
  const events = useRunEvents(agent.agent_id, run)
  const workflowId = run?.workflow_id ?? agent.workflow_id ?? DEFAULT_WORKFLOW_ID
  const { data: workflow } = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId) })
  const definition = workflow?.workflow.definition ?? null
  if (run === undefined) return <div className="skeleton h-64" />
  return (
    <div className="space-y-3">
      <RunHeader agentId={agent.agent_id} run={run} currentRevision={workflow?.workflow.revision} canControl={canControl}
        failureReason={failureReasonOf(run, events)} />
      <RunSummaryCard run={run} events={events} definition={definition} />
      <TechnicalLog run={run} events={events} definition={definition} open={technical} onToggle={onToggleTechnical} />
    </div>
  )
}

/** The step graph lit by the journal, and the event log — behind "Show technical log". */
function TechnicalLog({ run, events, definition, open, onToggle }: Readonly<{
  run: AgentRun; events: readonly RunEvent[]; definition: WorkflowDefinition | null; open: boolean; onToggle: () => void
}>) {
  const { t } = useTranslation('agents')
  const states = useMemo(() => stepStates(events, run.current_node_id), [events, run.current_node_id])
  const [focus, setFocus] = useState<string | null>(null)
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {open ? t('run.hideTechnical') : t('run.showTechnical')}
      </button>
      {open && (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="card p-0 h-[520px] overflow-hidden">
            {definition === null
              ? <p className="p-4 text-sm text-muted">{t('run.noGraph')}</p>
              : <WorkflowCanvas definition={definition} readOnly runStates={states} onStepClick={setFocus} />}
          </div>
          <EventLog events={events} definition={definition} focus={focus} onClearFocus={() => setFocus(null)} />
        </div>
      )}
    </>
  )
}

function RunHeader({ agentId, run, currentRevision, canControl, failureReason }: Readonly<{
  agentId: string; run: AgentRun; currentRevision: number | undefined; canControl: boolean; failureReason: string | null
}>) {
  const { t, i18n } = useTranslation('agents')
  const { cancelRun } = useAgentMutations(agentId)
  const projectName = useProjectName()
  const olderRevision = run.workflow_revision !== null && currentRevision !== undefined && run.workflow_revision !== currentRevision
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={run.status} />
        <span className="text-[12px] text-muted">{t(`run.triggers.${run.trigger}`)} · {when(run.started_at, i18n.language)}</span>
        <span className="text-[12px] text-muted font-mono">{t('run.calls', { n: run.model_calls })}</span>
        {olderRevision && (
          <span className="badge badge-info">{t('run.olderRevision', { n: run.workflow_revision })}</span>
        )}
        {run.project_id !== null && (
          <Link className="text-[12px] link" to={`/projects/${encodeURIComponent(run.project_id)}`}>{t('run.openNamedProject', { name: projectName(run.project_id) })}</Link>
        )}
        <span className="mr-auto" />
        {canControl && isActiveRun(run) && (
          <button type="button" className="btn btn-danger btn-sm" disabled={cancelRun.isPending} onClick={() => cancelRun.mutate(run.run_id)}>
            <Square size={14} aria-hidden="true" /> {t('run.cancel')}
          </button>
        )}
      </div>
      {/* A run waiting for a person is explained by its decision card, not a red error. */}
      {run.error !== null && run.status !== 'needs_human' && (
        <div role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[12px] text-danger">
          <p>{run.error}</p>
          {failureReason !== null && <p className="break-words">{t('run.failureReason', { reason: failureReason })}</p>}
        </div>
      )}
      <RunDecisionCard agentId={agentId} run={run} isAdmin={canControl} />
      {cancelRun.isError && <p role="alert" className="text-[12px] text-danger">{t('run.cancelFailed')}</p>}
    </>
  )
}

function RunList({ runs, selected, onSelect }: Readonly<{ runs: readonly AgentRun[]; selected: string | null; onSelect: (id: string) => void }>) {
  const { t, i18n } = useTranslation('agents')
  return (
    <ul className="space-y-1" aria-label={t('run.list')}>
      {runs.map((run) => {
        const isSelected = run.run_id === selected
        // On the selected (nav-active) row, secondary text is `text-text` and the
        // status pill sits on a card-coloured backing: `text-muted` was 4.09:1 and
        // light `badge-ok` 4.27:1 on --nav-active-bg (E2E s2 F6, design audit D-CONTRAST).
        const meta = isSelected ? 'text-text' : 'text-muted'
        return (
          <li key={run.run_id}>
            <button type="button" onClick={() => onSelect(run.run_id)} aria-current={isSelected ? 'true' : undefined}
              className={`w-full rounded-md px-3 py-2 text-left transition-colors focus-ring ${isSelected ? 'nav-active' : 'hover:bg-bg-hover'}`}>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                <span className={isSelected ? 'rounded-full bg-card' : undefined}><RunStatusBadge status={run.status} /></span>
                <span className={`text-[12px] ${meta} break-words`}>{t(`run.triggers.${run.trigger}`)}</span>
              </span>
              <span className={`block mt-0.5 text-[12px] ${meta} font-mono`}>{when(run.started_at, i18n.language)}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function RunNowBar({ agent, isAdmin, hasActive, onStarted }: Readonly<{
  agent: Agent; isAdmin: boolean; hasActive: boolean; onStarted: (runId: string) => void
}>) {
  const { t } = useTranslation('agents')
  const { runNow } = useAgentMutations(agent.agent_id)
  const [confirming, setConfirming] = useState(false)
  const startRun = () => runNow.mutate(undefined, {
    onSuccess: (run) => onStarted(run.run_id),
    onSettled: () => setConfirming(false),
  })
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] text-muted mr-auto">{t('run.hint')}</p>
        {isAdmin && (
          <button type="button" className="btn btn-primary btn-sm" disabled={runNow.isPending || hasActive}
            onClick={() => { runNow.reset(); setConfirming(true) }} title={hasActive ? t('run.alreadyRunning') : undefined}>
            {runNow.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            {t('run.runNow')}
          </button>
        )}
      </div>
      {runNow.isError && (
        <p role="alert" className="text-[12px] text-danger">
          {apiErrorStatus(runNow.error) === 409 ? t('run.alreadyRunning') : t('run.startFailed')}
        </p>
      )}
      {confirming && (
        <RunNowConfirm agent={agent} starting={runNow.isPending} onConfirm={startRun} onCancel={() => setConfirming(false)} />
      )}
    </>
  )
}

export function RunsTab({ agent, isAdmin }: Readonly<{ agent: Agent; isAdmin: boolean }>) {
  const runsQuery = useAgentRuns(agent.agent_id)
  const [picked, setPicked] = useState<string | null>(null)
  const runs = runsQuery.data?.items ?? []
  return (
    <div className="space-y-3">
      <RunNowBar agent={agent} isAdmin={isAdmin} hasActive={runs.some(isActiveRun)} onStarted={setPicked} />
      <RunsBody
        agent={agent} isAdmin={isAdmin} runs={runs} isLoading={runsQuery.isLoading}
        failure={failedReads([runsQuery])} picked={picked} onPick={setPicked}
      />
    </div>
  )
}

/** Loading, a failed read (not "No runs yet"), the empty line, or the list and the selected run. */
function RunsBody({ agent, isAdmin, runs, isLoading, failure, picked, onPick }: Readonly<{
  agent: Agent
  isAdmin: boolean
  runs: AgentRun[]
  isLoading: boolean
  failure: FailedReads
  picked: string | null
  onPick: (runId: string) => void
}>) {
  const { t } = useTranslation('agents')
  const [technical, setTechnical] = useState(false)
  if (isLoading) return <div className="skeleton h-40" />
  if (failure.loadFailed) return <LoadFailed onRetry={failure.retry} retrying={failure.retrying} />
  if (runs.length === 0) return <p className="card text-sm text-muted">{t('run.none')}</p>
  const selected = picked ?? runs.at(0)?.run_id ?? null
  return (
    <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside tabIndex={0} aria-label={t('run.list')} className="card p-2 max-h-[640px] overflow-y-auto focus-ring"><RunList runs={runs} selected={selected} onSelect={onPick} /></aside>
      {selected !== null && (
        <RunDetail key={selected} agent={agent} runId={selected} canControl={isAdmin}
          technical={technical} onToggleTechnical={() => setTechnical((open) => !open)} />
      )}
    </div>
  )
}
