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

function getSetupColors(color: string): {
  bg: string;
  border: string;
  title: string
} {
  if (color === 'blue') return {
    bg: 'bg-info-subtle',
    border: 'border-info/30',
    title: 'text-info',
  }
  if (color === 'green') return {
    bg: 'bg-ok-subtle',
    border: 'border-ok/30',
    title: 'text-ok',
  }
  if (color === 'orange') return {
    bg: 'bg-warn-subtle',
    border: 'border-warn/30',
    title: 'text-warn',
  }
  return {
    bg: 'bg-bg-accent',
    border: 'border-border',
    title: 'text-text-strong',
  }
}

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

function PluginField({
  field, value, showSecrets, onChange,
}: {
  readonly field: ConfigField
  readonly value: string
  readonly showSecrets: boolean
  readonly onChange: (value: string) => void
}) {
  const { t } = useTranslation('scrapers')
  // Labels are tied to their control so the field has an accessible name
  // (axe select-name / label) and clicking the label focuses it.
  const id = useId()
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
        className="input text-sm"
      />
    </div>
  )
}

/**
 * One `PluginField` per manifest config entry, laid out in the modals' field grid.
 * Secrets stay masked; `onChange` reports the edited field's key with its new value.
 */
export function PluginFieldGrid({
  fields, values, onChange,
}: {
  readonly fields: readonly ConfigField[]
  readonly values: Readonly<Record<string, string>>
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
          onChange={(v) => onChange(field.key, v)}
        />
      ))}
    </div>
  )
}

export function SetupInstructions({ setup }: { readonly setup: SetupInfo }) {
  const colors = getSetupColors(setup.color ?? 'blue')
  return (
    <div className={clsx('p-3 rounded-lg text-sm border', colors.bg, colors.border)}>
      <h3 className={clsx('text-sm font-semibold mb-2', colors.title)}>{setup.title}</h3>
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
