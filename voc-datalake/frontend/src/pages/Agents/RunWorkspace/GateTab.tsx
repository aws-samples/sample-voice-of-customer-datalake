/**
 * @fileoverview The inspector's Gate tab (7.51.00): the agent's gate (`…/gate`): its record's verdict and the
 * reviewers' findings (`voc-gate-record/1`), and its last gate run's deterministic checks, each with its status, exit
 * code, time and the tail of its output. An agent that ran no gate says so, and offers the run's gate agents.
 *
 * @module pages/Agents/RunWorkspace/GateTab
 */
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { formatDateTime } from '../../../utils/dateUtils'
import { useAgentGate } from './useRunWorkspace'
import type { AgentGate, GateCheck, GateFinding } from '../../../api/engineeringRunWorkspaceApi'

const CHECK_TONE: Readonly<Record<string, string>> = { pass: 'badge badge-ok', fail: 'badge badge-danger', error: 'badge badge-danger' }
const VERDICT_TONE: Readonly<Record<string, string>> = { GO: 'badge badge-ok', 'NO-GO': 'badge badge-danger' }

function Check({ check }: Readonly<{ check: GateCheck }>) {
  const { t } = useTranslation('agents')
  return (
    <li className="rounded-md border border-border">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-2 py-1 text-[12px]">
          <span className="font-mono font-medium">{check.key === '' ? check.name : `${check.key}: ${check.name}`}</span>
          <span className={CHECK_TONE[check.status] ?? 'badge badge-muted'}>{check.status}</span>
          {check.exit_code !== null && <span className="text-muted">{t('runWorkspace.gate.exit', { code: check.exit_code })}</span>}
          {check.duration_s !== null && <span className="text-muted">{t('runWorkspace.gate.duration', { seconds: check.duration_s })}</span>}
        </summary>
        {check.reason !== '' && <p className="px-2 text-[12px] text-muted">{check.reason}</p>}
        <pre className="max-h-48 overflow-auto bg-bg-accent px-2 py-1 text-[12px] whitespace-pre-wrap break-all">{check.output_tail || t('runWorkspace.gate.noOutput')}</pre>
      </details>
    </li>
  )
}

function Finding({ finding }: Readonly<{ finding: GateFinding }>) {
  const { t } = useTranslation('agents')
  const line = finding.line === null ? '' : `:${String(finding.line)}`
  const place = finding.file === '' ? '' : finding.file + line
  return (
    <li className="text-[12px]">
      <span className="badge badge-muted">{finding.severity}</span>{' '}
      <span className="font-medium">{finding.title}</span>
      {place !== '' && <span className="ml-1 font-mono text-muted">{place}</span>}
      <span className="ml-1 text-muted">
        {t('runWorkspace.gate.finding', { reviewer: finding.reviewer, outcome: finding.outcome })}
        {finding.outcome_note !== '' && ` (${finding.outcome_note})`}
      </span>
    </li>
  )
}

function GateView({ gate }: Readonly<{ gate: AgentGate }>) {
  const { t, i18n } = useTranslation('agents')
  const { record } = gate
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-[12px]">
        {record !== null && <span className={VERDICT_TONE[record.verdict] ?? 'badge badge-muted'}>{t('runWorkspace.gate.verdict', { verdict: record.verdict })}</span>}
        {gate.passed !== null && <span className={gate.passed ? 'badge badge-ok' : 'badge badge-danger'}>{t(gate.passed ? 'runWorkspace.gate.passed' : 'runWorkspace.gate.failed')}</span>}
        {gate.ran_at !== null && <span className="text-muted">{t('runWorkspace.gate.ranAt', { when: formatDateTime(gate.ran_at, i18n.language) })}</span>}
      </p>
      {gate.checks.length > 0 && (
        <ul className="space-y-1" aria-label={t('runWorkspace.gate.checks')}>
          {gate.checks.map((check, index) => <Check key={`${String(index)}-${check.key}`} check={check} />)}
        </ul>
      )}
      {record !== null && record.findings.length > 0 && (
        <ul className="space-y-1" aria-label={t('runWorkspace.gate.findings')}>
          {record.findings.map((finding) => <Finding key={finding.id} finding={finding} />)}
        </ul>
      )}
    </div>
  )
}

export function GateTab({ runId, agent, live, gateAgents, onOpen }: Readonly<{
  runId: string; agent: string; live: boolean; gateAgents: readonly string[]; onOpen: (agent: string) => void
}>) {
  const { t } = useTranslation('agents')
  const gate = useAgentGate(runId, agent, live)
  if (gate.isLoading) return <div className="skeleton h-24" />
  if (gate.data === undefined) return <LoadFailed onRetry={() => { void gate.refetch() }} retrying={gate.isFetching} />
  if (gate.data.record !== null || gate.data.checks.length > 0) return <GateView gate={gate.data} />
  const others = gateAgents.filter((other) => other !== agent)
  return (
    <div className="space-y-2 text-sm text-muted">
      <p>{t('runWorkspace.gate.none')}</p>
      {others.length > 0 && (
        <p className="flex flex-wrap gap-2">
          {others.map((other) => (
            <button key={other} type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen(other)}>
              {t('runWorkspace.gate.open', { agent: other })}
            </button>
          ))}
        </p>
      )}
    </div>
  )
}
