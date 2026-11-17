/**
 * @fileoverview A repository connection's CI attestation on Agents → Connections (administrators): whether one holds
 * (the row's chip, `CiBadge`), who recorded or withdrew it and when, or why it was voided (the row's details since
 * 7.52.00, connectionText.ts `useAttestationText`); recording one (`POST …/connections/<id>/ci-attestation`) after the administrator
 * confirms every point of the setup guide; and withdrawing it (`DELETE`) after a confirmation.
 *
 * A push to an agent branch can start the repository's own pipelines, and neither the GitHub App nor a GitLab
 * Developer token can read the settings that keep them harmless (the points keep their ids; a GitLab connection's
 * dialog names GitLab's settings: protected variables, the job token, id_tokens, runners, merge request pipelines), so the broker refuses every push and pull request on a connection until an administrator attests
 * them (docs/autonomous-engineering.md, "The target's CI"). The server records each change as a create-only version
 * with an audit row; a change of the connection's repository, or its removal, voids it.
 *
 * @module pages/Agents/CiAttestation
 */
import { useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import {
  CI_POINTS, engineeringConnectionsApi, engineeringConnectionsKeys, isCiAttested,
} from '../../api/engineeringConnectionsApi'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { OneLineNoteField } from './ConnectionFields'
import { ConnectionChangeConfirm, ConnectionFormModal } from './ConnectionModals'
import type { ConnectionConfirmProps } from './ConnectionModals'
import type {
  CiPoint, ConnectionList, EngineeringConnection, RecordedAttestation,
} from '../../api/engineeringConnectionsApi'

/** The longest note an attestation keeps (the server's MAX_REASON: longer is refused, never cut). */
const MAX_NOTE = 500

/** The list with the connection's newest attestation version, and the connection's version after it, replaced. */
function withAttestation(list: ConnectionList | undefined, connectionId: string,
  { attestation, connectionVersion }: RecordedAttestation): ConnectionList | undefined {
  if (list === undefined) return list
  return {
    ...list,
    connections: list.connections.map((c) => (c.connection_id === connectionId
      ? { ...c, ci_attestation: attestation, version: connectionVersion }
      : c)),
  }
}

/** The connection's CI chip (7.52.00): attested (the agents may push), or not (they push nothing until it is). */
export function CiBadge({ connection }: Readonly<{ connection: EngineeringConnection }>) {
  const { t } = useTranslation('agents')
  return isCiAttested(connection)
    ? <IconBadge toneClass="badge-ok" icon={ShieldCheck}>{t('connections.ci.attested')}</IconBadge>
    : <IconBadge toneClass="badge-warn" icon={ShieldAlert}>{t('connections.ci.notAttested')}</IconBadge>
}

type Checked = Readonly<Record<CiPoint, boolean>>

const NONE_CHECKED: Checked = {
  protected_secrets: false, read_only_token: false, oidc_pinned: false, no_self_hosted_runner: false,
  no_privileged_pull_request: false, branch_rules: false,
}

/** The setup guide's points, each a checkbox the administrator ticks; a note; and the record button. */
export function AttestDialog({ connection, onClose, onRecorded }: Readonly<{
  connection: EngineeringConnection; onClose: () => void; onRecorded: () => void
}>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const issueId = useId()
  const [checked, setChecked] = useState<Checked>(NONE_CHECKED)
  const [note, setNote] = useState('')
  const [missing, setMissing] = useState(false)
  const boxes = useRef<Partial<Record<CiPoint, HTMLInputElement | null>>>({})
  // (the same six points by id; a GitLab project's settings by GitLab's names for them)
  const gitlab = connection.host === 'gitlab'
  const record = useMutation({
    // (the repository and version this dialog shows: the server refuses the attestation once either changed)
    mutationFn: () => engineeringConnectionsApi.attest(connection, note),
    onSuccess: (recorded) => {
      queryClient.setQueryData<ConnectionList>(engineeringConnectionsKeys.list(),
        (list) => withAttestation(list, connection.connection_id, recorded))
      void queryClient.invalidateQueries({ queryKey: engineeringConnectionsKeys.list() })
      onRecorded()
    },
  })
  const submit = () => {
    const first = CI_POINTS.find((point) => !checked[point])
    setMissing(first !== undefined)
    if (first === undefined) {
      record.mutate()
      return
    }
    boxes.current[first]?.focus()
  }
  return (
    <ConnectionFormModal title={t('connections.ci.dialog.title', { repository: connection.repository })}
      description={t('connections.ci.dialog.description')} saveLabel={t('connections.ci.dialog.save')}
      pending={record.isPending} error={record.isError ? record.error : null} onClose={onClose} onSubmit={submit}>
      <fieldset className="space-y-2" aria-describedby={missing ? issueId : undefined}>
        <legend className="text-[12px] font-medium text-muted">{t('connections.ci.dialog.legend')}</legend>
        {CI_POINTS.map((point) => (
          <label key={point} className="flex items-start gap-2 text-sm text-text">
            <input type="checkbox" className="accent-accent mt-1 shrink-0" checked={checked[point]}
              aria-invalid={missing && !checked[point]}
              ref={(element) => { boxes.current[point] = element }}
              onChange={(event) => {
                setMissing(false)
                setChecked((current) => ({ ...current, [point]: event.target.checked }))
              }} />
            <span>{gitlab ? t(`connections.gitlab.ci.points.${point}`) : t(`connections.ci.points.${point}`)}</span>
          </label>
        ))}
      </fieldset>
      {missing && <p id={issueId} role="alert" className="text-[12px] text-danger">{t('connections.ci.dialog.allPoints')}</p>}
      <NoteField value={note} onChange={setNote} />
      <p className="text-[12px] text-muted">{gitlab ? t('connections.gitlab.ci.checked') : t('connections.ci.dialog.checked')}</p>
    </ConnectionFormModal>
  )
}

/** The administrator's optional note: kept with the version as its reason (one line, at most ``MAX_NOTE``). */
function NoteField({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const { t } = useTranslation('agents')
  return (
    <OneLineNoteField label={t('connections.ci.dialog.note')} hint={t('connections.ci.dialog.noteHint', { max: MAX_NOTE })}
      max={MAX_NOTE} value={value} onChange={onChange} />
  )
}

/** Withdraw the attestation, after a confirmation that says what the agents lose, with the administrator's note. */
export function WithdrawConfirm(props: ConnectionConfirmProps) {
  const { t } = useTranslation('agents')
  const [note, setNote] = useState('')
  const named = { repository: props.connection.repository }
  const withdraw = () => engineeringConnectionsApi.withdraw(props.connection.connection_id, note)
  return (
    <ConnectionChangeConfirm variant="warning" title={t('connections.ci.withdraw.title', named)}
      message={t('connections.ci.withdraw.message', named)} confirmLabel={t('connections.ci.withdraw.confirm')}
      change={withdraw} onDone={props.onDone} onCancel={props.onCancel}>
      <div className="mt-3"><NoteField value={note} onChange={setNote} /></div>
    </ConnectionChangeConfirm>
  )
}
