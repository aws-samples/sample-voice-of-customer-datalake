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
 * @module pages/Agents/ConnectionDialog
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
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
  const fields = useRef<Partial<Record<ConnectionField, HTMLInputElement | HTMLTextAreaElement | null>>>({})
  const save = useMutation({
    mutationFn: () => engineeringConnectionsApi.save(form.connectionId.trim(), connectionRequest(form)),
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
  const field = (name: ConnectionField, extra: { secret?: boolean; mono?: boolean; label?: string; hint?: string } = {}) => {
    const issue = issues[name]
    return (
      <ConnectionTextField key={name} field={name} value={form[name]} {...extra}
        issue={issue === undefined ? undefined : t(ISSUE_TEXT[issue], { max: MAX_BRANCH })}
        readOnly={name === 'connectionId' && existing !== null}
        hint={name === 'connectionId' && existing !== null ? t('connections.hints.connectionIdFixed') : extra.hint}
        inputRef={(element) => { fields.current[name] = element }} onChange={change(name)} />
    )
  }
  return (
    <ConnectionFormModal
      title={existing === null ? t('connections.dialog.addTitle') : t('connections.dialog.editTitle', { repository: existing.repository })}
      description={t('connections.dialog.description')} saveLabel={t('connections.dialog.save')} pending={save.isPending}
      error={save.isError ? save.error : null} onClose={onClose} onSubmit={submit}>
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
    </ConnectionFormModal>
  )
}
