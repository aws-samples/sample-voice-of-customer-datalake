/**
 * @fileoverview The MCP OAuth consent screen (`/oauth/authorize`, inside ProtectedRoute; docs/mcp.md →
 * "OAuth sign-in"). An MCP client's sign-in lands here with its authorization query unchanged (the
 * API's `GET /oauth/authorize` redirects to it). The signed-in person sees which assistant asks, picks
 * read or read-and-write and an optional project, then Approve sends them on to the account sign-in
 * (Cognito, with exactly the approved access) and Deny back to the assistant.
 *
 * The assistant acts as this person afterwards, never as an administrator and at most as an editor
 * on a project, exactly like a personal token.
 *
 * @module pages/OAuthConsent
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { CONNECT_SCOPES, isConnectScope } from '../../api/connectSchema'
import type { ConnectScope } from '../../api/connectSchema'
import { oauthApi, oauthConsentKey } from '../../api/oauthApi'
import type { ConsentDescription } from '../../api/oauthSchema'
import { projectsKey } from '../../api/projectQueryKeys'
import { projectsApi } from '../../api/projectsApi'
import { leaveTo } from './leaveApp'

type Approvable = Extract<ConsentDescription, { refused: false }>

function ConsentForm({ consent, authorizeQuery }: Readonly<{ consent: Approvable; authorizeQuery: string }>) {
  const { t } = useTranslation('common')
  const [scope, setScope] = useState<ConnectScope>('read')
  const [projectId, setProjectId] = useState('')
  const { data } = useQuery({ queryKey: projectsKey(), queryFn: () => projectsApi.getProjects() })
  const projects = useMemo(() => data?.projects ?? [], [data])
  const approve = useMutation({
    mutationFn: () => oauthApi.approveConsent({
      authorize_query: authorizeQuery, scope, ...(projectId ? { project_id: projectId } : {}),
    }),
    onSuccess: leaveTo,
  })

  return (
    <form className="card space-y-4" onSubmit={(event) => { event.preventDefault(); approve.mutate() }}>
      <p className="text-sm text-text">{t('oauthConsent.asks', { client: consent.client_name })}</p>
      <fieldset className="space-y-2">
        <legend className="text-[12px] font-medium text-muted">{t('connect.scopeLabel')}</legend>
        {CONNECT_SCOPES.filter((choice) => choice === 'read' || consent.can_write).map((choice) => (
          <label key={choice} className="flex items-start gap-2 text-sm">
            <input type="radio" name="scope" value={choice} checked={scope === choice}
              onChange={(event) => { if (isConnectScope(event.target.value)) setScope(event.target.value) }} />
            <span>{t(`oauthConsent.scope.${choice}`)}</span>
          </label>
        ))}
      </fieldset>
      <label className="block space-y-1 text-sm">
        <span className="text-[12px] font-medium text-muted">{t('connect.projectLabel')}</span>
        <select className="input w-full" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">{t('connect.projectAll')}</option>
          {projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
        </select>
      </label>
      <p className="text-[12px] text-muted">{t('oauthConsent.actsAs')}</p>
      {consent.can_run_agents && scope === 'write' && !projectId
        && <p className="text-[12px] text-muted">{t('oauthConsent.runsAgents')}</p>}
      {approve.isError && <p role="alert" className="text-sm text-danger">{t('oauthConsent.approveFailed')}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn btn-primary" disabled={approve.isPending}>{t('oauthConsent.approve')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => leaveTo(consent.deny_redirect)}>
          {t('oauthConsent.deny')}
        </button>
      </div>
    </form>
  )
}

function ConsentBody({ authorizeQuery }: Readonly<{ authorizeQuery: string }>) {
  const { t } = useTranslation('common')
  const consent = useQuery({
    queryKey: oauthConsentKey(authorizeQuery),
    queryFn: () => oauthApi.describeConsent(authorizeQuery),
    retry: false,
  })
  if (consent.isLoading) return <p className="text-sm text-muted">{t('connect.loading')}</p>
  if (consent.isError || !consent.data) {
    return <p role="alert" className="card text-sm text-danger">{t('oauthConsent.invalid')}</p>
  }
  if (consent.data.refused) {
    const { redirect_to: back } = consent.data
    return (
      <div role="alert" className="card space-y-2 text-sm">
        <p className="text-danger">{t('oauthConsent.refused', { reason: consent.data.error_description || consent.data.error })}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => leaveTo(back)}>{t('oauthConsent.back')}</button>
      </div>
    )
  }
  return <ConsentForm consent={consent.data} authorizeQuery={authorizeQuery} />
}

export default function OAuthConsent() {
  const { t } = useTranslation('common')
  const [searchParams] = useSearchParams()
  const authorizeQuery = searchParams.toString()
  return (
    <div className="max-w-xl mx-auto min-w-0 w-full space-y-4">
      <h1 className="text-2xl font-bold tracking-tight text-text-strong flex items-center gap-2">
        <KeyRound size={22} className="text-accent-text" aria-hidden="true" /> {t('oauthConsent.title')}
      </h1>
      {authorizeQuery
        ? <ConsentBody authorizeQuery={authorizeQuery} />
        : <p role="alert" className="card text-sm text-danger">{t('oauthConsent.invalid')}</p>}
    </div>
  )
}
