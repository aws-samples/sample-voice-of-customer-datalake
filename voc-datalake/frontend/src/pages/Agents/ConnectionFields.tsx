/**
 * @fileoverview The fields of a repository connection's dialog: one labelled text field (its hint, or what is wrong
 * with it, tied to it by aria-describedby), and what the GitHub App needs. The private key's input is write-only:
 * never prefilled, never offered to the browser's form filling, never spell-checked.
 *
 * @module pages/Agents/ConnectionFields
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import type { ConnectionField } from './connectionRules'

type FieldElement = HTMLInputElement | HTMLTextAreaElement

export interface ConnectionTextFieldProps {
  field: ConnectionField
  value: string
  /** What is wrong with the value, already translated; the field's hint otherwise. */
  issue: string | undefined
  /** A hint in place of the field's own (the fixed id of a connection being edited). */
  hint?: string
  /** A secret (the private key): pasted, sent once, never shown again (a textarea). */
  secret?: boolean
  readOnly?: boolean
  mono?: boolean
  inputRef: (element: FieldElement | null) => void
  onChange: (value: string) => void
}

export function ConnectionTextField({
  field, value, issue, hint, secret = false, readOnly = false, mono = false, inputRef, onChange,
}: Readonly<ConnectionTextFieldProps>) {
  const { t } = useTranslation('agents')
  const said = issue ?? hint ?? t(`connections.hints.${field}`)
  return (
    <LabeledField label={t(`connections.fields.${field}`)} hint={said} hintTone={issue === undefined ? 'muted' : 'danger'}>
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

/** What the GitHub App needs, what the tokens it mints may do, and how to keep the default branch safe. */
export function CredentialGuidance() {
  const { t } = useTranslation('agents')
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="rounded-md border border-border bg-bg-hover px-3 py-2 text-[12px] text-text space-y-1">
      <h3 id={titleId} className="font-medium text-text-strong">{t('connections.guidance.title')}</h3>
      <p>{t('connections.guidance.app')}</p>
      <p>{t('connections.guidance.token')}</p>
      <p>{t('connections.guidance.branch')}</p>
    </section>
  )
}
