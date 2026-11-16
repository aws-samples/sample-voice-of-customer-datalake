/**
 * @fileoverview The fields of a repository connection's dialog: the repository host (GitHub or GitLab), one labelled
 * text field (its hint, or what is wrong with it, tied to it by aria-describedby), a person's one-line note (a change's
 * reason, an attestation's note), and what each host's credential needs (the GitHub App; the GitLab project access token, its role, scopes and expiry). The private key's and the
 * token's inputs are write-only: never prefilled, never offered to the browser's form filling, never spell-checked.
 *
 * @module pages/Agents/ConnectionFields
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import RadioChoices from '../../components/RadioChoices/RadioChoices'
import { CONNECTION_HOSTS } from '../../api/engineeringConnectionsApi'
import type { ConnectionHost } from '../../api/engineeringConnectionsApi'
import type { ConnectionField } from './connectionRules'

type FieldElement = HTMLInputElement | HTMLTextAreaElement

export interface ConnectionTextFieldProps {
  field: ConnectionField
  value: string
  /** What is wrong with the value, already translated; the field's hint otherwise. */
  issue: string | undefined
  /** A hint in place of the field's own (the fixed id of a connection being edited, a GitLab project's path). */
  hint?: string
  /** A label in place of the field's own (a GitLab project's path). */
  label?: string
  /** A secret (the private key): pasted, sent once, never shown again (a textarea). */
  secret?: boolean
  readOnly?: boolean
  mono?: boolean
  inputRef: (element: FieldElement | null) => void
  onChange: (value: string) => void
}

export function ConnectionTextField({
  field, value, issue, hint, label, secret = false, readOnly = false, mono = false, inputRef, onChange,
}: Readonly<ConnectionTextFieldProps>) {
  const { t } = useTranslation('agents')
  const said = issue ?? hint ?? t(`connections.hints.${field}`)
  return (
    <LabeledField label={label ?? t(`connections.fields.${field}`)} hint={said} hintTone={issue === undefined ? 'muted' : 'danger'}>
      {(id) => {
        const shared = {
          id, ref: inputRef, value, readOnly, 'aria-invalid': issue !== undefined, 'aria-describedby': `${id}-hint`,
          autoComplete: 'off', spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off',
          className: mono || secret ? 'input w-full font-mono' : 'input w-full',
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        }
        if (secret) return <textarea {...shared} rows={5} />
        return <input {...shared} type="text" />
      }}
    </LabeledField>
  )
}

/** The repository host a connection reaches: one choice of two, GitHub or GitLab. */
export function HostChoice({ value, onChange }: Readonly<{ value: ConnectionHost; onChange: (host: ConnectionHost) => void }>) {
  const { t } = useTranslation('agents')
  return (
    <RadioChoices legend={t('connections.hostLabel')} choices={CONNECTION_HOSTS} value={value} onChange={onChange}
      display={(host) => t(`connections.hosts.${host}`)} legendClassName="text-[12px] font-medium text-muted"
      rowClassName="flex flex-wrap gap-4" labelClassName="inline-flex items-center gap-2 text-sm text-text"
      inputClassName="accent-accent" />
  )
}

/** The guidance's paragraphs, by host, under `connections.guidance` (GitHub's) and `connections.gitlab.guidance`. */
const GUIDANCE: Readonly<Record<ConnectionHost, { title: string; lines: readonly string[] }>> = {
  github: {
    title: 'connections.guidance.title',
    lines: ['connections.guidance.app', 'connections.guidance.token', 'connections.guidance.branch'],
  },
  gitlab: {
    title: 'connections.gitlab.guidance.title',
    lines: ['connections.gitlab.guidance.token', 'connections.gitlab.guidance.expiry', 'connections.gitlab.guidance.branch'],
  },
}

/** A person's one-line note kept with a change (a connection's reason, an attestation's note): at most `max` characters,
 *  longer refused by the server, never cut. */
export function OneLineNoteField({ label, hint, max, value, onChange }: Readonly<{
  label: string; hint: string; max: number; value: string; onChange: (value: string) => void
}>) {
  return (
    <LabeledField label={label} hint={hint}>
      {(id) => (
        <input id={id} type="text" className="input w-full" value={value} maxLength={max}
          aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.value)} />
      )}
    </LabeledField>
  )
}

/** What a host's credential needs (the GitHub App and the tokens it mints; the GitLab project access token and its
 *  expiry), and how to keep the default branch safe; both hosts' when none is given. */
export function CredentialGuidance({ host }: Readonly<{ host?: ConnectionHost }>) {
  return host === undefined
    ? <>{CONNECTION_HOSTS.map((each) => <HostGuidance key={each} host={each} />)}</>
    : <HostGuidance host={host} />
}

function HostGuidance({ host }: Readonly<{ host: ConnectionHost }>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  const { title, lines } = GUIDANCE[host]
  return (
    <section aria-labelledby={titleId} className="rounded-md border border-border bg-bg-hover px-3 py-2 text-[12px] text-text space-y-1">
      <h3 id={titleId} className="font-medium text-text-strong">{t(title)}</h3>
      {lines.map((line) => <p key={line}>{t(line)}</p>)}
    </section>
  )
}
