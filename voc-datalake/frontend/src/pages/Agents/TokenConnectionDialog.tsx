/**
 * @fileoverview Connect a repository with a fine-grained token, or replace a token connection's token (7.60.00,
 * administrators; docs/autonomous-engineering.md "A fine-grained token (7.60.00)"): for a public repository the person
 * can push to but cannot install the GitHub App on (an organization whose owners approve apps, say).
 *
 * The dialog takes the repository (typed, or found on GitHub: TokenConnectionParts.tsx), says what to make on GitHub
 * (the resource owner, Only select repositories → the repository, Contents and Pull requests both Read and write, 90
 * days or less) with GitHub's new-token page prefilled, the token (a password field) and the person's tick "This token
 * can reach only ‹repo›". The server checks the token on GitHub (`POST /agents/engineering/token-connections`, or `PUT
 * …/connections/<id>/token` to replace it) and refuses it with a code, each said here in plain words
 * (`connections.token.refused.*`); its other refusals (a field, a conflict) in its own words.
 *
 * The token lives only in this dialog's state and the one request: the mutation takes no variables (nothing of it is
 * kept in the query client), it is cleared once saved, and it goes with the dialog.
 *
 * @module pages/Agents/TokenConnectionDialog
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { tokenConnectionsApi } from '../../api/tokenConnectionsApi'
import { apiErrorCode } from '../../lib/errors'
import { OneLineNoteField } from './ConnectionFields'
import { ConnectionFormModal } from './ConnectionModals'
import { keepSaved } from './savedConnection'
import { OnlyThisRepository, RepositoryPick, TokenField, TokenSteps } from './TokenConnectionParts'
import { knownRefusal, repositoryOf, fineGrainedTokenIssue } from './tokenConnectionRules'
import type { EngineeringConnection, SavedConnection } from '../../api/engineeringConnectionsApi'
import type { TokenIssue, TokenRefusalCode } from './tokenConnectionRules'

/** The longest reason a change takes (lambda/engineering/connectors/connections.py MAX_REASON). */
const MAX_REASON = 500

/** Each refusal code's words. */
const REFUSED: Readonly<Record<TokenRefusalCode, string>> = {
  classic_token: 'connections.token.refused.classic_token',
  not_accepted: 'connections.token.refused.not_accepted',
  no_expiry: 'connections.token.refused.no_expiry',
  expires_too_late: 'connections.token.refused.expires_too_late',
  expired: 'connections.token.refused.expired',
  not_found: 'connections.token.refused.not_found',
  private_repository: 'connections.token.refused.private_repository',
  archived: 'connections.token.refused.archived',
  no_push: 'connections.token.refused.no_push',
  org_pending_approval: 'connections.token.refused.org_pending_approval',
  other_repositories: 'connections.token.refused.other_repositories',
}

/** Each pasted token's issue's words. */
const TOKEN_ISSUES: Readonly<Record<TokenIssue, string>> = {
  tokenEmpty: 'connections.token.invalid.tokenEmpty',
  classic: 'connections.token.invalid.classic',
  shape: 'connections.token.invalid.shape',
}

/** What the form says is wrong before anything is sent. */
interface FormIssues {
  repository: boolean
  token: TokenIssue | undefined
  tick: boolean
}

const NO_ISSUES: FormIssues = { repository: false, token: undefined, tick: false }

/** The request: a new connection's, or the replace of `existing`'s token. */
function saveRequest(existing: EngineeringConnection | null, repository: string, token: string,
  reason: string): Promise<SavedConnection> {
  if (existing === null) return tokenConnectionsApi.create({ repository, token, reason })
  return tokenConnectionsApi.replace(existing.connection_id, { token, reason })
    .then((connection) => ({ connection, created: false }))
}

/** The save, its token cleared once saved and the list updated with what the server stored. */
function useTokenSave(existing: EngineeringConnection | null, form: Readonly<{ repository: string; token: string; reason: string }>,
  onSaved: (saved: SavedConnection) => void, clearToken: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => saveRequest(existing, form.repository, form.token.trim(), form.reason),
    onSuccess: (saved) => {
      clearToken()
      keepSaved(queryClient, saved.connection)
      onSaved(saved)
    },
  })
}

/** The dialog's title and save button, by whether it connects a repository or replaces a token. */
function useDialogWords(existing: EngineeringConnection | null) {
  const { t } = useTranslation('agents')
  return existing === null
    ? { title: t('connections.token.dialog.addTitle'), save: t('connections.token.dialog.save') }
    : { title: t('connections.token.dialog.replaceTitle', { repository: existing.repository }), save: t('connections.token.dialog.replace') }
}

/** The repository: picked for a new connection, or the stored connection's own (fixed) for a replace. */
function RepositoryArea({ existing, typed, invalid, onChange }: Readonly<{
  existing: EngineeringConnection | null; typed: string; invalid: boolean; onChange: (value: string) => void
}>) {
  const { t } = useTranslation('agents')
  if (existing !== null) {
    return <p className="text-sm text-text">{t('connections.token.repository.fixed', { repository: existing.repository })}</p>
  }
  return <RepositoryPick value={typed} issue={invalid ? t('connections.token.invalid.repository') : null} onChange={onChange} />
}

export function TokenConnectionDialog({ existing, onClose, onSaved }: Readonly<{
  /** The token connection whose token is replaced; null to connect a repository. */
  existing: EngineeringConnection | null
  onClose: () => void
  onSaved: (saved: SavedConnection) => void
}>) {
  const { t } = useTranslation('agents')
  const words = useDialogWords(existing)
  const [typed, setTyped] = useState(existing?.repository ?? '')
  const [token, setToken] = useState('')
  const [ticked, setTicked] = useState(false)
  const [reason, setReason] = useState('')
  const [issues, setIssues] = useState<FormIssues>(NO_ISSUES)
  const repository = repositoryOf(typed)
  const save = useTokenSave(existing, { repository: repository ?? '', token, reason }, onSaved, () => { setToken('') })
  const refusal = save.isError ? knownRefusal(apiErrorCode(save.error)) : null
  const submit = () => {
    const found = { repository: repository === null, token: fineGrainedTokenIssue(token), tick: !ticked }
    setIssues(found)
    if (!found.repository && found.token === undefined && !found.tick) save.mutate()
  }
  const clearIssue = (key: keyof FormIssues) => { setIssues((current) => ({ ...current, [key]: key === 'token' ? undefined : false })) }
  return (
    <ConnectionFormModal title={words.title} description={t('connections.token.dialog.description')} saveLabel={words.save}
      pending={save.isPending} error={refusal === null && save.isError ? save.error : null} onClose={onClose} onSubmit={submit}>
      <RepositoryArea existing={existing} typed={typed} invalid={issues.repository}
        onChange={(value) => { clearIssue('repository'); setTyped(value) }} />
      {repository !== null && <TokenSteps repository={repository} />}
      <TokenField value={token} issue={issues.token === undefined ? null : t(TOKEN_ISSUES[issues.token])}
        onChange={(value) => { clearIssue('token'); setToken(value) }} />
      {repository !== null && (
        <OnlyThisRepository repository={repository} checked={ticked} missing={issues.tick}
          onChange={(checked) => { clearIssue('tick'); setTicked(checked) }} />
      )}
      <OneLineNoteField label={t('connections.dialog.reason')} hint={t('connections.dialog.reasonHint', { max: MAX_REASON })}
        max={MAX_REASON} value={reason} onChange={setReason} />
      {refusal !== null && (
        <p role="alert" className="text-[12px] text-danger">{t(REFUSED[refusal], { repository: repository ?? '' })}</p>
      )}
    </ConnectionFormModal>
  )
}
