/**
 * @fileoverview The go of a run on a fine-grained token connection (7.60.00), in the run's header beside its control
 * bar: every push and pull request of such a run goes with a person's own token, so it waits for that person's go, in
 * every way of working (AI-driven included). The button reads **Push with ‹login›'s token** and only the token's owner
 * (the connection's `saved_by_you`) can press it; anyone else is told whose go it waits for. It gives the run's go
 * (`POST /agents/engineering/<run_id>/go`, api/engineeringGoApi.ts), once: a go given already is said as such, and the
 * server's own refusal of a go from anyone but the owner (403 `token_owner_go`) in plain words.
 *
 * The connection is the run's own (the overview's `connection`, found in the connections' list, which this page's
 * administrators read; a run whose overview names none is matched by its repository); a run on any other kind of
 * connection shows nothing here.
 *
 * @module pages/Agents/RunWorkspace/RunTokenGo
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2 } from 'lucide-react'
import { engineeringConnectionsApi, engineeringConnectionsKeys, isTokenConnection } from '../../../api/engineeringConnectionsApi'
import { TOKEN_OWNER_GO, engineeringGoApi } from '../../../api/engineeringGoApi'
import { apiErrorCode } from '../../../lib/errors'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'
import type { RunGo } from '../../../api/engineeringGoApi'

/** The run's token connection (by its id, else its repository), once the list is read; null for none. */
function useTokenConnection(connectionId: string | null, repository: string): EngineeringConnection | null {
  const list = useQuery({ queryKey: engineeringConnectionsKeys.list(), queryFn: engineeringConnectionsApi.list, retry: false })
  const wanted = repository.toLowerCase()
  const ours = (connection: EngineeringConnection) => (connectionId === null
    ? connection.repository.toLowerCase() === wanted : connection.connection_id === connectionId)
  return list.data?.connections.find((connection) => isTokenConnection(connection) && ours(connection)) ?? null
}

/** What the go did, or why it was refused. */
function GoOutcome({ go, error, login }: Readonly<{ go: RunGo | undefined; error: unknown; login: string }>) {
  const { t } = useTranslation('agents')
  if (go !== undefined) {
    return <p role="status" className="text-[12px] text-ok">{go.created ? t('runWorkspace.tokenGo.given', { login }) : t('runWorkspace.tokenGo.already')}</p>
  }
  if (error === null) return null
  const refused = apiErrorCode(error) === TOKEN_OWNER_GO
  return <p role="alert" className="text-[12px] text-danger">{refused ? t('runWorkspace.tokenGo.refused') : t('runWorkspace.tokenGo.failed')}</p>
}

/** The button, for the token's owner; for anyone else, whose go it waits for. */
function GoButton({ runId, connection }: Readonly<{ runId: string; connection: EngineeringConnection }>) {
  const { t } = useTranslation('agents')
  const login = connection.credential.login ?? connection.credential.owner ?? '?'
  const give = useMutation({ mutationFn: () => engineeringGoApi.give(runId) })
  if (!connection.credential.saved_by_you) {
    return <p className="text-[12px] text-muted">{t('runWorkspace.tokenGo.ownerOnly', { owner: connection.credential.owner ?? login, login })}</p>
  }
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" aria-disabled={give.isPending || give.isSuccess || undefined}
        onClick={() => { if (!give.isPending && !give.isSuccess) give.mutate() }}>
        {give.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <KeyRound size={14} aria-hidden="true" />}
        {t('runWorkspace.tokenGo.push', { login })}
      </button>
      <GoOutcome go={give.data} error={give.isError ? give.error : null} login={login} />
    </>
  )
}

export function RunTokenGo({ runId, connectionId = null, repository }: Readonly<{
  runId: string; connectionId?: string | null; repository: string
}>) {
  const { t } = useTranslation('agents')
  const connection = useTokenConnection(connectionId, repository)
  if (connection === null) return null
  const login = connection.credential.login ?? '?'
  return (
    <div className="space-y-1" data-testid="run-token-go">
      <p className="text-[12px] text-text">{t('runWorkspace.tokenGo.hint', { login })}</p>
      <GoButton runId={runId} connection={connection} />
    </div>
  )
}
