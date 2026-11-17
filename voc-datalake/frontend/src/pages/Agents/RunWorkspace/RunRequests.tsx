/**
 * @fileoverview Agents → Runs' run requests (7.53.00, "MCP for runs", D53-3): the Run nows a local Kiro or Claude agent
 * asked for over MCP (`engineering_run_request`), waiting for an administrator because a run pushes code. Each says
 * which automation, on what (an issue, a PRD, or a bug hunt), the note it came with (shown as data), which MCP token
 * asked and when it expires. Confirm runs the automation's Run now as the person confirming, and then links the run;
 * Decline starts nothing. Nothing shows while no request waits (`GET /agents/engineering/requests`, read again every
 * 30 seconds while the page is open).
 *
 * @module pages/Agents/RunWorkspace/RunRequests
 */
import { useId } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { runRequestsApi, runRequestsKeys } from '../../../api/engineeringRunRequestsApi'
import { runWorkspaceKeys } from '../../../api/engineeringRunWorkspaceApi'
import { formatDateTime } from '../../../utils/dateUtils'
import { useActionError } from '../engineeringRunText'
import { runWorkspacePath } from './runWorkspacePaths'
import type { RunRequest, RunRequestDecision } from '../../../api/engineeringRunRequestsApi'

/** How often the waiting requests are read again while the Runs list is open. */
const REFETCH_MS = 30_000

/** What the Run now is on: an issue, a PRD, or (a bug automation without either) a bug hunt of the repository. */
function useTarget(): (request: RunRequest) => string {
  const { t } = useTranslation('agents')
  return (request) => {
    if (request.issue !== null) return t('runWorkspace.requests.onIssue', { number: request.issue })
    if (request.prd !== null) {
      return t('runWorkspace.requests.onPrd', { document: request.prd.document_id, project: request.prd.project_id })
    }
    return t('runWorkspace.requests.onHunt')
  }
}

function RequestRow({ request, busy, onDecide }: Readonly<{
  request: RunRequest; busy: boolean; onDecide: (decision: RunRequestDecision) => void
}>) {
  const { t, i18n } = useTranslation('agents')
  const target = useTarget()(request)
  return (
    <li className="flex flex-wrap items-start gap-3 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-text-strong break-words">
          {request.agent_name || request.agent_id}{' · '}{target}
        </span>
        {request.note !== null && (
          <span className="block text-[12px] text-text break-words">{t('runWorkspace.requests.note', { note: request.note })}</span>
        )}
        <span className="block text-[12px] text-muted break-words">
          {t('runWorkspace.requests.asked', { via: request.via, when: formatDateTime(request.requested_at, i18n.language, '—') })}
          {' · '}{t('runWorkspace.requests.expires', { when: formatDateTime(request.expires_at, i18n.language, '—') })}
        </span>
      </span>
      <span className="flex gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onDecide('confirm')}>
          {t('runWorkspace.requests.confirm')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onDecide('decline')}>
          {t('runWorkspace.requests.decline')}
        </button>
      </span>
    </li>
  )
}

/** What came of the last decision: the run it started (a link), or that nothing started. */
function Decided({ request }: Readonly<{ request: RunRequest }>) {
  const { t } = useTranslation('agents')
  if (request.status !== 'confirmed') return <p role="status" className="text-[12px] text-muted">{t('runWorkspace.requests.declined')}</p>
  return (
    <p role="status" className="text-[12px] text-muted">
      {t('runWorkspace.requests.confirmed')}
      {request.engineering_run_id !== null && (
        <> <Link className="link" to={runWorkspacePath(request.engineering_run_id)}>{t('runWorkspace.requests.openRun')}</Link></>
      )}
    </p>
  )
}

export function RunRequests() {
  const { t } = useTranslation('agents')
  const headingId = useId()
  const actionError = useActionError()
  const queryClient = useQueryClient()
  const { data, isError } = useQuery({ queryKey: runRequestsKeys.list(), queryFn: runRequestsApi.list, refetchInterval: REFETCH_MS })
  const decide = useMutation({
    mutationFn: ({ requestId, decision }: { requestId: string; decision: RunRequestDecision }) =>
      decision === 'confirm' ? runRequestsApi.confirm(requestId) : runRequestsApi.decline(requestId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: runRequestsKeys.list() })
      void queryClient.invalidateQueries({ queryKey: runWorkspaceKeys.runsLists() })
    },
  })
  const waiting = (data ?? []).filter((request) => request.status === 'pending')
  if (isError) return <p role="alert" className="text-[12px] text-danger">{t('runWorkspace.requests.loadFailed')}</p>
  if (waiting.length === 0 && decide.data === undefined && decide.error === null) return null
  return (
    <section aria-labelledby={headingId} className="card space-y-2 p-3">
      <h2 id={headingId} className="text-sm font-semibold text-text-strong">{t('runWorkspace.requests.title')}</h2>
      <p className="max-w-prose text-[12px] text-muted">{t('runWorkspace.requests.hint')}</p>
      {waiting.length > 0 && (
        <ul className="space-y-2">
          {waiting.map((request) => (
            <RequestRow key={request.request_id} request={request} busy={decide.isPending}
              onDecide={(decision) => decide.mutate({ requestId: request.request_id, decision })} />
          ))}
        </ul>
      )}
      {decide.error !== null && <p role="alert" className="text-[12px] text-danger">{actionError(decide.error)}</p>}
      {decide.data !== undefined && <Decided request={decide.data} />}
    </section>
  )
}
