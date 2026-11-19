/**
 * @fileoverview A person's GitHub authorization of one of the deployment's Apps, on its card on Agents → Connections
 * (7.57.00). The run on a fork connection ends with its pull request on the upstream one click away (GitHub's compare
 * page: the person clicks Create). Optionally the broker opens it for them, as the fork connection's owner, through the
 * App's user authorization (its user-to-server token, which only the broker reads and no agent ever holds). So each
 * App's card says, for the person looking at it:
 *
 * - **Authorized as @login**, with **Remove my authorization** (forgotten here; revoking it on GitHub stays theirs:
 *   Settings → Applications → Authorized GitHub Apps);
 * - or **Authorize as me**: GitHub's authorization page, in this tab (the workspace remembered, as every GitHub
 *   link), whose return is GitHubAppAuthorized.tsx;
 * - or, for an App made before 7.57.00 (its creation discarded the OAuth client secret), **Set the App's OAuth
 *   client…**: its client id and a new client secret generated on GitHub, stored on the server and never shown back,
 *   with the Callback URL to add on GitHub.
 *
 * Shown on an App's card only where it matters: the App's OAuth client is stored, or the deployment reads a public
 * repository or contributes to one through a fork.
 *
 * @module pages/Agents/AppAuthorization
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, UserCheck } from 'lucide-react'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { CLIENT_ID, githubAppsApi, githubAppsKeys } from '../../api/githubAppsApi'
import { PAGE_WORKSPACE } from '../../workspace/workspacePath'
import { ConnectionChangeConfirm, ConnectionFormModal } from './ConnectionModals'
import { useConnectionError } from './connectionText'
import { leavingForGitHub } from './githubReturn'
import type { GitHubApp, GitHubAppList } from '../../api/githubAppsApi'

/** Where GitHub sends a person back from an App's authorization (routes.tsx; the server's manifest `callback_urls`). */
const AUTHORIZED_PATH = '/agents/connections/github/authorized'
/** The longest client secret the form takes. */
const MAX_SECRET_CHARS = 200

/** Which field of the OAuth client form is off (the id as GitHub shows one, a secret pasted), or null for none. */
function invalidField(clientId: string, secret: string): 'id' | 'secret' | null {
  if (!CLIENT_ID.test(clientId.trim())) return 'id'
  return secret.trim() === '' || secret.length > MAX_SECRET_CHARS ? 'secret' : null
}

/** Set the App's OAuth client…: its client id and a new client secret, written to the server, never read back. */
function OAuthClientDialog({ app, onClose, onSaved }: Readonly<{ app: GitHubApp; onClose: () => void; onSaved: () => void }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const idField = useId()
  const secretField = useId()
  const [clientId, setClientId] = useState(app.client_id ?? '')
  const [secret, setSecret] = useState('')
  const [invalid, setInvalid] = useState<'id' | 'secret' | null>(null)
  const save = useMutation({
    mutationFn: () => githubAppsApi.setOAuthClient(app.app_id, { client_id: clientId.trim(), client_secret: secret.trim() }),
    onSuccess: (saved) => {
      setSecret('')
      queryClient.setQueryData<GitHubAppList>(githubAppsKeys.list(), (list) => (list === undefined ? list : {
        ...list, apps: list.apps.map((entry) => (entry.app_id === saved.app_id ? saved : entry)),
      }))
      void queryClient.invalidateQueries({ queryKey: githubAppsKeys.list() })
      onSaved()
    },
  })
  const submit = () => {
    const bad = invalidField(clientId, secret)
    setInvalid(bad)
    if (bad === null) save.mutate()
  }
  const callback = `${window.location.origin}${AUTHORIZED_PATH}`
  return (
    <ConnectionFormModal title={t('connections.authorization.clientTitle', { slug: app.slug })}
      description={t('connections.authorization.clientDescription')} saveLabel={t('connections.authorization.clientSave')}
      pending={save.isPending} error={save.isError ? save.error : null} onClose={onClose} onSubmit={submit}>
      <p className="text-[12px] text-text">{t('connections.authorization.clientHint')}</p>
      <p className="text-[12px] text-text">
        {t('connections.authorization.callbackHint')} <code className="font-mono break-all">{callback}</code>
      </p>
      <div className="space-y-1">
        <label htmlFor={idField} className="block text-sm font-medium text-text">{t('connections.authorization.clientId')}</label>
        <input id={idField} className="input font-mono" value={clientId} autoComplete="off" spellCheck={false}
          aria-invalid={invalid === 'id'} onChange={(event) => { setClientId(event.target.value) }} />
        {invalid === 'id' && <p className="text-[12px] text-danger">{t('connections.authorization.clientIdInvalid')}</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor={secretField} className="block text-sm font-medium text-text">{t('connections.authorization.clientSecret')}</label>
        <input id={secretField} type="password" className="input font-mono" value={secret} autoComplete="off" spellCheck={false}
          aria-invalid={invalid === 'secret'} onChange={(event) => { setSecret(event.target.value) }} />
        <p className={invalid === 'secret' ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
          {invalid === 'secret' ? t('connections.authorization.clientSecretInvalid') : t('connections.authorization.clientSecretHint')}
        </p>
      </div>
    </ConnectionFormModal>
  )
}

/**
 * Authorize as me: GitHub's authorization page for the caller and the App, in this tab (also step 3 of contributing,
 * ContributeCard.tsx, where the step says what it is for).
 */
export function AuthorizeButton({ app, note }: Readonly<{ app: GitHubApp; note?: string }>) {
  const { t } = useTranslation('agents')
  const errorText = useConnectionError()
  const authorize = useMutation({
    mutationFn: () => githubAppsApi.authorize(app.app_id, PAGE_WORKSPACE.kind === 'slug' ? PAGE_WORKSPACE.slug : undefined),
    onSuccess: ({ authorizeUrl }) => { leavingForGitHub(); window.location.assign(authorizeUrl) },
  })
  return (
    <>
      <p className="flex flex-wrap items-center gap-2 text-muted">
        {note !== undefined && <span>{note}</span>}
        <button type="button" className="btn btn-secondary btn-sm" aria-label={`${t('connections.authorization.authorize')} ${app.slug}`}
          aria-disabled={authorize.isPending || undefined} onClick={() => { if (!authorize.isPending) authorize.mutate() }}>
          {authorize.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('connections.authorization.authorize')}
        </button>
      </p>
      {authorize.isError && <p role="alert" className="text-danger">{errorText(authorize.error)}</p>}
    </>
  )
}

/** The caller's authorization of an App whose OAuth client is stored: as whom (with Remove), or Authorize as me. */
function StoredClientLine({ app, onRemove }: Readonly<{ app: GitHubApp; onRemove: () => void }>) {
  const { t } = useTranslation('agents')
  const authorizations = useQuery({ queryKey: githubAppsKeys.authorizations(), queryFn: githubAppsApi.authorizations, retry: false })
  if (authorizations.isPending) return <p role="status" className="text-muted">{t('connections.authorization.reading')}</p>
  if (authorizations.isError) return <p className="text-muted">{t('connections.authorization.unreadable')}</p>
  const mine = authorizations.data.find((entry) => entry.app_id === app.app_id)
  if (mine === undefined) return <AuthorizeButton app={app} note={t('connections.authorization.needed')} />
  return (
    <p className="flex flex-wrap items-center gap-2">
      <IconBadge toneClass="badge-ok" icon={UserCheck}>{t('connections.authorization.as', { login: mine.login })}</IconBadge>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRemove}>{t('connections.authorization.remove')}</button>
    </p>
  )
}

/** The App's line for the person: authorized as them, or Authorize as me, or its OAuth client to store first. */
export function AppAuthorization({ app, onNotice }: Readonly<{ app: GitHubApp; onNotice: (text: string) => void }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<'client' | 'remove' | null>(null)
  return (
    <div className="space-y-1 px-4 pb-3 text-[12px]" data-testid={`app-authorization-${app.app_id}`}>
      {app.oauth ? <StoredClientLine app={app} onRemove={() => { setOpen('remove') }} /> : (
        <p className="flex flex-wrap items-center gap-2 text-muted">
          <span>{t('connections.authorization.noClient')}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setOpen('client') }}>
            {t('connections.authorization.setClient')}
          </button>
        </p>
      )}
      {open === 'client' && (
        <OAuthClientDialog app={app} onClose={() => { setOpen(null) }}
          onSaved={() => { setOpen(null); onNotice(t('connections.authorization.clientSaved', { slug: app.slug })) }} />
      )}
      {open === 'remove' && (
        <ConnectionChangeConfirm variant="warning" title={t('connections.authorization.removeTitle', { slug: app.slug })}
          message={t('connections.authorization.removeMessage')} confirmLabel={t('connections.authorization.removeConfirm')}
          change={() => githubAppsApi.removeAuthorization(app.app_id)} onCancel={() => { setOpen(null) }}
          onDone={() => {
            setOpen(null)
            void queryClient.invalidateQueries({ queryKey: githubAppsKeys.authorizations() })
            onNotice(t('connections.authorization.removed', { slug: app.slug }))
          }} />
      )}
    </div>
  )
}
