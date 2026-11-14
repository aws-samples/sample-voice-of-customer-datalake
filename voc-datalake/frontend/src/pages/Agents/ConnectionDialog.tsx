/**
 * @fileoverview Add or edit a repository connection (`PUT /agents/engineering/connections/<id>`, administrators): its
 * id (chosen when it is added, fixed afterwards), the repository, its default branch, and the GitHub App's
 * credential (its ids and its private key). The stored key is never read back: editing shows only whether a
 * credential is set and the App's ids, and an empty key keeps the stored credential (a new repository or App needs
 * the key again). Each field is checked as the server checks it before anything is sent; a refusal is said in the
 * server's words when it gives them.
 *
 * The key lives only in this dialog's state and the one request: the mutation takes no variables (nothing of it is
 * kept in the query client), it is cleared once saved, and it goes with the dialog when it closes.
 *
 * @module pages/Agents/ConnectionDialog
 */
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { engineeringConnectionsApi, engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import { ConnectionTextField, CredentialGuidance } from './ConnectionFields'
import { ConnectionFormModal } from './ConnectionModals'
import { EMPTY_CONNECTION_FORM, MAX_BRANCH, connectionIssues, connectionRequest } from './connectionRules'
import type { ConnectionList, EngineeringConnection, SavedConnection } from '../../api/engineeringConnectionsApi'
import type { ConnectionField, ConnectionForm, ConnectionIssues } from './connectionRules'

/** The fields in the order they are shown (the first wrong one is focused). */
const FIELD_ORDER: readonly ConnectionField[] = [
  'connectionId', 'repository', 'defaultBranch', 'appId', 'installationId', 'privateKey',
]

const formOf = (existing: EngineeringConnection | null): ConnectionForm => (existing === null
  ? { ...EMPTY_CONNECTION_FORM }
  : {
      ...EMPTY_CONNECTION_FORM, connectionId: existing.connection_id, repository: existing.repository,
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
  return (
    <div className="rounded-md border border-border px-3 py-2 space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-sm text-text-strong">
        {t('connections.dialog.stored')} {t('connections.kind')}
        <span className={set ? 'badge badge-ok' : 'badge badge-warn'}>{set ? t('connections.set') : t('connections.notSet')}</span>
      </p>
      <p className="text-[12px] text-muted">{t('connections.dialog.keepHint')}</p>
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
      setForm((current) => ({ ...current, privateKey: '' }))
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
  const field = (name: ConnectionField, extra: { secret?: boolean; mono?: boolean } = {}) => {
    const issue = issues[name]
    return (
      <ConnectionTextField key={name} field={name} value={form[name]} {...extra}
        issue={issue === undefined ? undefined : t(`connections.invalid.${issue}`, { max: MAX_BRANCH })}
        readOnly={name === 'connectionId' && existing !== null}
        hint={name === 'connectionId' && existing !== null ? t('connections.hints.connectionIdFixed') : undefined}
        inputRef={(element) => { fields.current[name] = element }} onChange={change(name)} />
    )
  }
  return (
    <ConnectionFormModal
      title={existing === null ? t('connections.dialog.addTitle') : t('connections.dialog.editTitle', { repository: existing.repository })}
      description={t('connections.dialog.description')} saveLabel={t('connections.dialog.save')} pending={save.isPending}
      error={save.isError ? save.error : null} onClose={onClose} onSubmit={submit}>
      {field('connectionId', { mono: true })}
      {field('repository', { mono: true })}
      {field('defaultBranch', { mono: true })}
      {existing !== null && <StoredCredential connection={existing} />}
      {field('appId', { mono: true })}
      {field('installationId', { mono: true })}
      {field('privateKey', { secret: true })}
      <CredentialGuidance />
    </ConnectionFormModal>
  )
}
