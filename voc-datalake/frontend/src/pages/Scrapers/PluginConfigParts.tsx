/**
 * @fileoverview Shared sub-components for the Plugin Config Modal.
 * @module pages/Scrapers/PluginConfigParts
 */

import clsx from 'clsx'
import {
  AlertCircle, CheckCircle2,
} from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ConfigField, SetupInfo,
} from '../../plugins/types'

function FieldLabel({ htmlFor, label, required }: Readonly<{ htmlFor: string; label: string; required: boolean }>) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-text mb-1">
      {label}
      {required ? <span className="text-danger ml-1" aria-hidden="true">*</span> : null}
    </label>
  )
}

/** A config select's empty "choose…" option followed by the field's own options. */
export function ConfigFieldOptions({ placeholder, options }: Readonly<{
  placeholder: string
  options: NonNullable<ConfigField['options']>
}>) {
  return <>
    <option value="">{placeholder}</option>
    {options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
  </>
}

/** A text field's line under it: what it may hold (its description), and why what was typed cannot be saved. */
export interface FieldNote {
  readonly hint: string
  /** Set: the field is invalid (`aria-invalid`), and this says why, as an alert. */
  readonly error?: string
}

function FieldNoteLines({ id, note }: Readonly<{ id: string; note: FieldNote }>) {
  return (
    <>
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted">{note.hint}</p>
      {note.error === undefined ? null : <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger">{note.error}</p>}
    </>
  )
}

function PluginField({
  field, value, showSecrets, note, onChange,
}: {
  readonly field: ConfigField
  readonly value: string
  readonly showSecrets: boolean
  readonly note?: FieldNote
  readonly onChange: (value: string) => void
}) {
  const { t } = useTranslation('scrapers')
  // Labels are tied to their control so the field has an accessible name
  // (axe select-name / label) and clicking the label focuses it.
  const id = useId()
  const describedBy = note === undefined ? undefined : clsx(`${id}-hint`, note.error !== undefined && `${id}-error`)
  const placeholder = field.placeholder ?? `Enter ${field.label.toLowerCase()}`
  const required = field.required === true
  const label = <FieldLabel htmlFor={id} label={field.label} required={required} />

  if (field.type === 'select' && field.options) {
    return (
      <div>
        {label}
        <select id={id} value={value} required={required} onChange={(e) => onChange(e.target.value)} className="select">
          <ConfigFieldOptions placeholder={t('pluginConfig.select')} options={field.options} />
        </select>
      </div>
    )
  }

  if (field.type === 'textarea') {
    return (
      <div>
        {label}
        <textarea
          id={id}
          value={value}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input text-sm min-h-[80px]"
        />
      </div>
    )
  }

  const inputType = field.type === 'password' && !showSecrets ? 'password' : 'text'

  return (
    <div>
      {label}
      <input
        id={id}
        type={inputType}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-describedby={describedBy}
        aria-invalid={note?.error === undefined ? undefined : true}
        className="input text-sm"
      />
      {note === undefined ? null : <FieldNoteLines id={id} note={note} />}
    </div>
  )
}

/**
 * One `PluginField` per manifest config entry, laid out in the modals' field grid.
 * Secrets stay masked; `onChange` reports the edited field's key with its new value; a text field may carry a
 * note (`notes`: its hint, and why what was typed cannot be saved).
 */
export function PluginFieldGrid({
  fields, values, notes, onChange,
}: {
  readonly fields: readonly ConfigField[]
  readonly values: Readonly<Record<string, string>>
  /** A text field's hint and error, by its key (a review page's name). */
  readonly notes?: Readonly<Partial<Record<string, FieldNote>>>
  readonly onChange: (key: string, value: string) => void
}) {
  return (
    <div className="grid gap-3">
      {fields.map((field) => (
        <PluginField
          key={field.key}
          field={field}
          value={values[field.key] ?? ''}
          showSecrets={false}
          note={notes?.[field.key]}
          onChange={(v) => onChange(field.key, v)}
        />
      ))}
    </div>
  )
}

export function SetupInstructions({ setup }: { readonly setup: SetupInfo }) {
  // One neutral panel for every plugin: the manifest's `setup.color` is identity, not a
  // state, so it no longer paints the panel (labels vs status, design-system rule 15).
  return (
    <div className="p-3 rounded-lg text-sm border bg-bg-accent border-border">
      <h3 className="text-sm font-semibold mb-2 text-text-strong">{setup.title}</h3>
      <ol className="list-decimal list-inside space-y-1 text-xs text-text">
        {setup.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
    </div>
  )
}

export function ResultMessage({
  success, message,
}: {
  readonly success: boolean;
  readonly message: string
}) {
  const bgClass = success ? 'bg-ok-subtle text-ok' : 'bg-danger-subtle text-danger'
  const Icon = success ? CheckCircle2 : AlertCircle
  return (
    <div className={clsx('p-3 rounded-lg text-sm', bgClass)}>
      <Icon size={14} className="inline mr-2" />
      {message}
    </div>
  )
}
