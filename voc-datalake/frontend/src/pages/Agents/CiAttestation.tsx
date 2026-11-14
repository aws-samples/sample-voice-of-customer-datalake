/**
 * @fileoverview A repository connection's CI attestation on Agents → Connections (administrators): whether one holds,
 * who recorded or withdrew it and when, or why it was voided; recording one (`POST …/connections/<id>/ci-attestation`)
 * after the administrator confirms every point of the setup guide; and withdrawing it (`DELETE`) after a confirmation.
 *
 * A push to an agent branch can start the repository's own pipelines, and the GitHub App cannot read the settings that
 * keep them harmless, so the broker refuses every push and pull request on a connection until an administrator attests
 * them (docs/autonomous-engineering.md, "The target's CI"). The server records each change as a create-only version
 * with an audit row; a change of the connection's repository, or its removal, voids it.
 *
 * @module pages/Agents/CiAttestation
 */
import { useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import {
  CI_POINTS, engineeringConnectionsApi, engineeringConnectionsKeys, isCiAttested,
} from '../../api/engineeringConnectionsApi'
import { formatDateTime } from '../../utils/dateUtils'
import { ConnectionChangeConfirm, ConnectionFormModal } from './ConnectionModals'
import type { ConnectionConfirmProps } from './ConnectionModals'
import type {
  CiAttestation, CiPoint, ConnectionList, EngineeringConnection, RecordedAttestation,
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

/** What the connection's newest version says, in a sentence. */
function useAttestationText(): (attestation: CiAttestation | null) => string {
  const { t, i18n } = useTranslation('agents')
  return (attestation) => {
    if (attestation === null) return t('connections.ci.none')
    const who = attestation.by ?? t('connections.ci.unknownPerson')
    const when = formatDateTime(attestation.at, i18n.language, '')
    if (attestation.state === 'attested') return t('connections.ci.attestedBy', { who, when })
    if (attestation.state === 'withdrawn') return t('connections.ci.withdrawnBy', { who, when })
    return attestation.cause === 'connection_removed' ? t('connections.ci.voidedRemoved') : t('connections.ci.voidedRepository')
  }
}

/** The connection's CI attestation line: a badge, and what holds (or why nothing does). */
export function CiAttestationLine({ connection }: Readonly<{ connection: EngineeringConnection }>) {
  const { t } = useTranslation('agents')
  const text = useAttestationText()
  const attested = isCiAttested(connection)
  const Icon = attested ? ShieldCheck : ShieldAlert
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className={attested ? 'badge badge-ok inline-flex items-center gap-1' : 'badge badge-warn inline-flex items-center gap-1'}>
        <Icon size={12} aria-hidden="true" /> {attested ? t('connections.ci.attested') : t('connections.ci.notAttested')}
      </span>
      <span className={attested ? 'text-muted' : 'text-warn'}>{text(connection.ci_attestation)}</span>
    </p>
  )
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
            <span>{t(`connections.ci.points.${point}`)}</span>
          </label>
        ))}
      </fieldset>
      {missing && <p id={issueId} role="alert" className="text-[12px] text-danger">{t('connections.ci.dialog.allPoints')}</p>}
      <NoteField value={note} onChange={setNote} />
      <p className="text-[12px] text-muted">{t('connections.ci.dialog.checked')}</p>
    </ConnectionFormModal>
  )
}

/** The administrator's optional note: kept with the version as its reason (one line, at most ``MAX_NOTE``). */
function NoteField({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const { t } = useTranslation('agents')
  return (
    <LabeledField label={t('connections.ci.dialog.note')} hint={t('connections.ci.dialog.noteHint', { max: MAX_NOTE })}>
      {(id) => (
        <input id={id} type="text" className="input w-full" value={value} maxLength={MAX_NOTE}
          aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.value)} />
      )}
    </LabeledField>
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
