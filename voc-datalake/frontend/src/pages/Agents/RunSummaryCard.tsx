/**
 * @fileoverview The plain-language summary that heads a run: what happened, how it
 * ended, what it produced and what (if anything) needs you. The step graph and the
 * event log stay available behind "Show technical log" (RunsTab).
 *
 * Built from the run and its event journal only: the outcome from `status` /
 * `error`, the current step from `current_node_id` against the workflow, what it
 * produced from the `artifact` events (each linked into its project, named by the
 * project's name — never its id), and stored ids inside the text read as names.
 *
 * @module pages/Agents/RunSummaryCard
 */
import { Link } from 'react-router-dom'
import { CircleCheck, CircleAlert, FileText, Hand, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLabelKnownIds, useProjectName } from '../../hooks/useLabelKnownIds'
import { formatDateTime } from '../../utils/dateUtils'
import { projectDocumentPath } from '../ProjectDetail/useDocumentSelection'
import type { ReactNode } from 'react'
import type { AgentRun, RunEvent } from '../../api/agentsApi'
import type { WorkflowDefinition } from '../../api/workflowsApi'

/** Where an artifact lives: its document, else its project; null without a project. */
function artifactPath(ref: RunEvent['ref']): string | null {
  const projectId = ref?.project_id
  if (projectId === undefined) return null
  return ref?.document_id === undefined ? `/projects/${encodeURIComponent(projectId)}` : projectDocumentPath(projectId, ref.document_id)
}

/** One sentence for how the run stands or ended. */
function OutcomeLine({ run, stepTitle }: Readonly<{ run: AgentRun; stepTitle: string | undefined }>) {
  const { t, i18n } = useTranslation('agents')
  const labelIds = useLabelKnownIds()
  const finished = formatDateTime(run.finished_at, i18n.language)
  if (run.status === 'running' || run.status === 'queued') {
    const text = stepTitle === undefined ? t(`run.summary.outcome.${run.status}`) : t('run.summary.outcome.runningStep', { step: stepTitle })
    return <p className="flex items-center gap-1.5 text-sm text-text"><Loader2 size={14} className="animate-spin" aria-hidden /> {text}</p>
  }
  if (run.status === 'failed') {
    return (
      <p className="flex items-start gap-1.5 text-sm text-danger">
        <CircleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
        {run.error === null ? t('run.summary.outcome.failed') : t('run.summary.outcome.failedBecause', { reason: labelIds(run.error) })}
      </p>
    )
  }
  if (run.status === 'needs_human') return <p className="flex items-center gap-1.5 text-sm text-warn"><Hand size={14} aria-hidden /> {t('run.summary.outcome.needs_human')}</p>
  const key = run.status === 'completed' ? 'completed' : 'cancelled'
  return (
    <p className="flex items-center gap-1.5 text-sm text-text">
      <CircleCheck size={14} className={key === 'completed' ? 'text-ok' : 'text-muted'} aria-hidden />
      {finished === '' ? t(`run.summary.outcome.${key}`) : t(`run.summary.outcome.${key}At`, { when: finished })}
    </p>
  )
}

function Produced({ events }: Readonly<{ events: readonly RunEvent[] }>) {
  const { t } = useTranslation('agents')
  const labelIds = useLabelKnownIds()
  const projectName = useProjectName()
  const artifacts = events.filter((e) => e.kind === 'artifact')
  if (artifacts.length === 0) return <p className="text-sm text-muted">{t('run.summary.producedNothing')}</p>
  return (
    <ul className="space-y-1">
      {artifacts.map((event) => {
        const path = artifactPath(event.ref)
        const projectId = event.ref?.project_id
        const text = labelIds(event.summary.trim() === '' ? t('run.summary.anArtifact') : event.summary)
        return (
          <li key={event.seq} className="flex items-start gap-1.5 text-sm">
            <FileText size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 break-words">
              {path === null ? text : <Link to={path} className="link">{text}</Link>}
              {projectId === undefined ? null : <span className="text-muted"> · {t('run.summary.inProject', { name: projectName(projectId) })}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium text-muted">{title}</h3>
      {children}
    </div>
  )
}

export function RunSummaryCard({ run, events, definition }: Readonly<{
  run: AgentRun; events: readonly RunEvent[]; definition: WorkflowDefinition | null
}>) {
  const { t, i18n } = useTranslation('agents')
  const started = formatDateTime(run.started_at, i18n.language)
  const stepTitle = definition?.nodes.find((n) => n.id === run.current_node_id)?.data.title
  return (
    <section aria-label={t('run.summary.title')} className="card p-4 space-y-3">
      <Section title={t('run.summary.title')}>
        <p className="text-sm text-text">
          {started === '' ? t(`run.summary.started.${run.trigger}`) : t(`run.summary.startedAt.${run.trigger}`, { when: started })}
        </p>
        <OutcomeLine run={run} stepTitle={stepTitle} />
      </Section>
      <Section title={t('run.summary.produced')}><Produced events={events} /></Section>
      <Section title={t('run.summary.needsYou')}>
        <p className="text-sm text-text">{run.status === 'needs_human' ? t('run.summary.needsDecision') : t('run.summary.needsNothing')}</p>
      </Section>
    </section>
  )
}
