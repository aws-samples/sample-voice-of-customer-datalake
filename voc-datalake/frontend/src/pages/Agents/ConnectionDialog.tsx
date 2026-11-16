/**
 * @fileoverview Add or edit a repository connection (`PUT /agents/engineering/connections/<id>`, administrators): its
 * id (chosen when it is added, fixed afterwards), its host (GitHub or GitLab), the repository (a GitLab project's
 * path), its default branch, and the credential: the GitHub App's (its ids and its private key) or a GitLab project
 * access token, with what each needs. The stored credential is never read back: editing shows only whether one is
 * set and the App's ids, and an empty key or token keeps it (a new host, repository or App needs it again). Each
 * field is checked as the server checks it before anything is sent; a refusal (a GitLab token GitLab itself refused,
 * say) is said in the server's words when it gives them.
 *
 * The key and the token live only in this dialog's state and the one request: the mutation takes no variables
 * (nothing of them is kept in the query client), they are cleared once saved, and they go with the dialog.
 *
 * A connection the GitHub App's installation saved (`app_reference`, 7.45.00) has no key of its own: its host, its
 * repository, its App and its installation are fixed, so its dialog shows them read only and offers what can change,
 * the default branch and the reason (7.49.00).
 *
 * The dialog is at most the viewport's height (ConnectionFormModal): its body scrolls between a fixed header and footer.
 *
 * @module pages/Agents/ConnectionDialog
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { ConnectionTextField, CredentialGuidance, HostChoice } from './ConnectionFields'
import { ConnectionFormModal } from './ConnectionModals'
import { EMPTY_CONNECTION_FORM, MAX_BRANCH, connectionIssues, connectionRequest } from './connectionRules'
import type {
  ConnectionHost, ConnectionList, EngineeringConnection, SavedConnection,
} from '../../api/engineeringConnectionsApi'
import type { ConnectionField, ConnectionForm, ConnectionIssue, ConnectionIssues } from './connectionRules'

/** The fields in the order they are shown (the first wrong one is focused). */
const FIELD_ORDER: readonly ConnectionField[] = [
  'connectionId', 'repository', 'defaultBranch', 'appId', 'installationId', 'privateKey', 'token',
]

/** Each issue's message (`connections.invalid`, and GitLab's own under `connections.gitlab.invalid`). */
const ISSUE_TEXT: Readonly<Record<ConnectionIssue, string>> = {
  connectionId: 'connections.invalid.connectionId', repository: 'connections.invalid.repository',
  defaultBranch: 'connections.invalid.defaultBranch', appId: 'connections.invalid.appId',
  installationId: 'connections.invalid.installationId', privateKeyEmpty: 'connections.invalid.privateKeyEmpty',
  privateKeyNeeded: 'connections.invalid.privateKeyNeeded', privateKey: 'connections.invalid.privateKey',
  privateKeyLarge: 'connections.invalid.privateKeyLarge', repositoryGitlab: 'connections.gitlab.invalid.repository',
  tokenEmpty: 'connections.gitlab.invalid.tokenEmpty', tokenNeeded: 'connections.gitlab.invalid.tokenNeeded',
  token: 'connections.gitlab.invalid.token',
}

const formOf =(existing: EngineeringConnection | null): ConnectionForm => (existing === null
  ? { ...EMPTY_CONNECTION_FORM }
  : {
      ...EMPTY_CONNECTION_FORM, host: existing.host, connectionId: existing.connection_id, repository: existing.repository,
      defaultBranch: existing.default_branch,
      // (not secret: an App's ids are shown back; its key never is)
      appId: existing.credential.app_id ?? '', installationId: existing.credential.installation_id ?? '',
    })

/** The list with the saved connection in it (replaced in place, or added at the end). */
function withSaved(list: ConnectionList | undefined, saved: EngineeringConnection): ConnectionList | undefined {
  if (list === undefined) return list
  const index = list.connections.findIndex((c) => c.connection_id === saved.connection_id)
  return { ...list, connections: index === -1 ? [...list.connections, saved] : list.connections.map((c, i) => (i === index ? saved : c)) }
}

/** The longest reason a change takes (lambda/engineering/connectors/connections.py MAX_REASON). */
const MAX_REASON = 500

/** An App-created connection's App and installation: fixed, and its key is the App's own. */
function AppReference({ connection }: Readonly<{ connection: EngineeringConnection }>) {
  const { t } = useTranslation('agents')
  const { app_id: appId, installation_id: installationId } = connection.credential
  return (
    <div className="rounded-md border border-border bg-bg-hover px-3 py-2 space-y-1" data-testid="connection-app-reference">
      <p className="text-sm font-medium text-text-strong">{t('connections.dialog.appCreatedTitle')}</p>
      <p className="text-sm text-text font-mono break-all">{t('connections.appIds', { appId: appId ?? '', installationId: installationId ?? '' })}</p>
      <p className="text-[12px] text-muted">{t('connections.dialog.appCreatedHint')}</p>
    </div>
  )
}

/** Why the change is made: one line, kept with the connection's audit row. */
function ReasonField({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const { t } = useTranslation('agents')
  return (
    <LabeledField label={t('connections.dialog.reason')} hint={t('connections.dialog.reasonHint', { max: MAX_REASON })}>
      {(id) => (
        <input id={id} type="text" className="input w-full" value={value} maxLength={MAX_REASON}
          aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.value)} />
      )}
    </LabeledField>
  )
}

function StoredCredential({ connection }: Readonly<{ connection: EngineeringConnection }>) {
  const { t } = useTranslation('agents')
  const { set } = connection.credential
  const gitlab = connection.host === 'gitlab'
  return (
    <div className="rounded-md border border-border px-3 py-2 space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-sm text-text-strong">
        {t('connections.dialog.stored')} {gitlab ? t('connections.kindToken') : t('connections.kind')}
        <span className={set ? 'badge badge-ok' : 'badge badge-warn'}>{set ? t('connections.set') : t('connections.notSet')}</span>
      </p>
      <p className="text-[12px] text-muted">{gitlab ? t('connections.gitlab.keepHint') : t('connections.dialog.keepHint')}</p>
    </div>
  )
}

export function ConnectionDialog({ existing, onClose, onSaved }: Readonly<{
  /** The connection being edited; null to add one. */
  existing: EngineeringConnection | null
  onClose: () => void
  onSaved: (saved: SavedConnection) => void
}>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ConnectionForm>(() => formOf(existing))
  const [issues, setIssues] = useState<ConnectionIssues>({})
  const [reason, setReason] = useState('')
  const fields = useRef<Partial<Record<ConnectionField, HTMLInputElement | HTMLTextAreaElement | null>>>({})
  const appCreated = existing?.credential.kind === 'app_reference'
  const save = useMutation({
    mutationFn: () => engineeringConnectionsApi.save(form.connectionId.trim(), {
      ...connectionRequest(form), ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
    }),
    onSuccess: (saved) => {
      setForm((current) => ({ ...current, privateKey: '', token: '' }))
      queryClient.setQueryData<ConnectionList>(engineeringConnectionsKeys.list(), (list) => withSaved(list, saved.connection))
      void queryClient.invalidateQueries({ queryKey: engineeringConnectionsKeys.list() })
      onSaved(saved)
    },
  })
  const change = (field: ConnectionField) => (value: string) => {
    // (a field's message goes once it is changed; the next Save checks again)
    setIssues((current) => ({ ...current, [field]: undefined }))
    setForm((current) => ({ ...current, [field]: value }))
  }
  const submit = () => {
    const found = connectionIssues(form, existing)
    const first = FIELD_ORDER.find((field) => found[field] !== undefined)
    setIssues(found)
    if (first === undefined) {
      save.mutate()
      return
    }
    fields.current[first]?.focus()
  }
  const chooseHost = (host: ConnectionHost) => {
    // (another host's fields and their messages go: only the chosen host's are checked and sent)
    setIssues({})
    setForm((current) => ({ ...current, host }))
  }
  const gitlab = form.host === 'gitlab'
  const field = (name: ConnectionField, extra: { secret?: boolean; mono?: boolean; label?: string; hint?: string; readOnly?: boolean } = {}) => {
    const issue = issues[name]
    return (
      <ConnectionTextField key={name} field={name} value={form[name]} {...extra}
        issue={issue === undefined ? undefined : t(ISSUE_TEXT[issue], { max: MAX_BRANCH })}
        readOnly={extra.readOnly === true || (name === 'connectionId' && existing !== null)}
        hint={name === 'connectionId' && existing !== null ? t('connections.hints.connectionIdFixed') : extra.hint}
        inputRef={(element) => { fields.current[name] = element }} onChange={change(name)} />
    )
  }
  return (
    <ConnectionFormModal
      title={existing === null ? t('connections.dialog.addTitle') : t('connections.dialog.editTitle', { repository: existing.repository })}
      description={t('connections.dialog.description')} saveLabel={t('connections.dialog.save')} pending={save.isPending}
      error={save.isError ? save.error : null} onClose={onClose} onSubmit={submit}>
      {existing !== null && appCreated ? (
        <>
          {field('connectionId', { mono: true })}
          {field('repository', { mono: true, readOnly: true, hint: t('connections.dialog.repositoryFixed') })}
          <AppReference connection={existing} />
          {field('defaultBranch', { mono: true })}
          <ReasonField value={reason} onChange={setReason} />
        </>
      ) : (
        <>
          <HostChoice value={form.host} onChange={chooseHost} />
          {field('connectionId', { mono: true })}
          {gitlab
            ? field('repository', { mono: true, label: t('connections.gitlab.fields.project'), hint: t('connections.gitlab.hints.project') })
            : field('repository', { mono: true })}
          {field('defaultBranch', { mono: true })}
          {existing !== null && <StoredCredential connection={existing} />}
          {gitlab ? field('token', { mono: true, label: t('connections.gitlab.fields.token'), hint: t('connections.gitlab.hints.token') }) : [
            field('appId', { mono: true }), field('installationId', { mono: true }), field('privateKey', { secret: true }),
          ]}
          <CredentialGuidance host={form.host} />
        </>
      )}
    </ConnectionFormModal>
  )
}
