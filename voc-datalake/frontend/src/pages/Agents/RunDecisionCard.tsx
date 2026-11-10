/**
 * @fileoverview A run that stopped for a person (`status: needs_human`): why,
 * the persona verdicts, the project, and — for admins — the decision form
 * (RunDecisionForm: what happens next, from the choices `run.actions` allows).
 * After a decision the card gives way to one line saying who chose what; the
 * resumed run polls again like any active run.
 *
 * @module pages/Agents/RunDecisionCard
 */
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, Hand } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '../../utils/dateUtils'
import { RunDecisionForm } from './RunDecisionForm'
import type { AgentRun } from '../../api/agentsApi'
import type { NeedsHuman, RunDecision, RunVerdict } from '../../api/agentRunDecision'

/** Why the run stopped for a person (also on Home's decision cards); a null reason reads as the generic sentence. */
export function ReasonLine({ needsHuman }: Readonly<{ needsHuman: NeedsHuman | null }>) {
  const { t } = useTranslation('agents')
  const reason = needsHuman?.reason ?? 'unknown'
  return (
    <p className="text-sm text-text">
      {t(`decision.reason.${reason}`, { node: needsHuman?.node_title ?? '', rounds: needsHuman?.max_rounds ?? 0 })}
    </p>
  )
}

function Verdict({ verdict }: Readonly<{ verdict: RunVerdict }>) {
  const { t } = useTranslation('agents')
  return (
    <li className="space-y-0.5">
      <p className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="font-semibold text-text-strong">{verdict.name}</span>
        <span className="font-mono text-muted">{t('decision.score', { score: verdict.score })}</span>
        {verdict.blocking && <span className="badge badge-danger">{t('decision.blocking')}</span>}
      </p>
      {verdict.objections.length > 0 && (
        <ul className="list-disc pl-5 text-[12px] text-text">
          {verdict.objections.map((objection) => <li key={objection}>{objection}</li>)}
        </ul>
      )}
    </li>
  )
}

function Verdicts({ verdicts }: Readonly<{ verdicts: readonly RunVerdict[] }>) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (verdicts.length === 0) return null
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className="space-y-1.5">
      <button type="button" className="btn btn-ghost btn-sm -ml-2" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        <Chevron size={14} aria-hidden="true" /> {t('decision.verdicts', { count: verdicts.length })}
      </button>
      {open && <ul id={listId} className="space-y-2">{verdicts.map((v, i) => <Verdict key={`${i}-${v.name}`} verdict={v} />)}</ul>}
    </div>
  )
}

/** "{by} chose … at …" (and the note sent with it). */
function DecisionLine({ decision }: Readonly<{ decision: RunDecision }>) {
  const { t, i18n } = useTranslation('agents')
  return (
    <div role="status" className="rounded-md border border-border bg-card px-3 py-2 text-[12px] text-text space-y-0.5">
      <p>{t(`decision.decided.${decision.decision}`, { by: decision.by_username, at: formatDateTime(decision.at, i18n.language) })}</p>
      {decision.note !== undefined && decision.note !== '' && (
        <p className="text-muted whitespace-pre-wrap break-words">{t('decision.decidedNote', { note: decision.note })}</p>
      )}
    </div>
  )
}

export function RunDecisionCard({ agentId, run, isAdmin }: Readonly<{ agentId: string; run: AgentRun; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  if (run.status !== 'needs_human') return run.decision === null ? null : <DecisionLine decision={run.decision} />
  return (
    <section aria-label={t('decision.title')} className="rounded-md border border-warn/30 bg-warn-subtle px-3 py-3 space-y-2">
      <p className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <Hand size={16} className="text-warn" aria-hidden="true" /> {t('decision.title')}
      </p>
      <ReasonLine needsHuman={run.needs_human} />
      {/* The decision form lists the objections itself when it offers to fix them. */}
      {!(isAdmin && run.actions.includes('another_round')) && <Verdicts verdicts={run.needs_human?.verdicts ?? []} />}
      {run.project_id !== null && (
        <Link className="inline-block text-[12px] link" to={`/projects/${encodeURIComponent(run.project_id)}`}>{t('run.openProject')}</Link>
      )}
      {run.decision !== null && <DecisionLine decision={run.decision} />}
      {isAdmin && run.actions.length > 0 && <RunDecisionForm agentId={agentId} run={run} />}
      {!isAdmin && <p className="text-[12px] text-muted">{t('decision.adminOnly')}</p>}
    </section>
  )
}
