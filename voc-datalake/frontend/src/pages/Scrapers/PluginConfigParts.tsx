/**
 * @fileoverview Shared sub-components for the Plugin Config Modal.
 * @module pages/Scrapers/PluginConfigParts
 */

import clsx from 'clsx'
import {
  AlertCircle, CheckCircle2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ConfigField, SetupInfo,
} from '../../plugins/types'

function getSetupColors(color: string): {
  bg: string;
  border: string;
  title: string;
  text: string
} {
  if (color === 'blue') return {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    title: 'text-blue-900',
    text: 'text-blue-800',
  }
  if (color === 'green') return {
    bg: 'bg-green-50',
    border: 'border-green-200',
    title: 'text-green-900',
    text: 'text-green-800',
  }
  if (color === 'orange') return {
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    title: 'text-orange-900',
    text: 'text-orange-800',
  }
  return {
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    title: 'text-gray-900',
    text: 'text-gray-700',
  }
}

export function PluginField({
  field, value, showSecrets, onChange,
}: {
  readonly field: ConfigField
  readonly value: string
  readonly showSecrets: boolean
  readonly onChange: (value: string) => void
}) {
  const { t } = useTranslation('scrapers')
  const placeholder = field.placeholder ?? `Enter ${field.label.toLowerCase()}`

  if (field.type === 'select' && field.options) {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-600 mb-1">
          {field.label}
          {field.required === true ? <span className="text-red-500 ml-1">*</span> : null}
        </label>
        <select value={value} onChange={(e) => onChange(e.target.value)} className="input text-sm">
          <option value="">{t('pluginConfig.select')}</option>
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === 'textarea') {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-600 mb-1">
          {field.label}
          {field.required === true ? <span className="text-red-500 ml-1">*</span> : null}
        </label>
        <textarea
          value={value}
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
      <label className="block text-sm font-medium text-gray-600 mb-1">
        {field.label}
        {field.required === true ? <span className="text-red-500 ml-1">*</span> : null}
      </label>
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input text-sm"
      />
    </div>
  )
}

export function SetupInstructions({ setup }: { readonly setup: SetupInfo }) {
  const colors = getSetupColors(setup.color ?? 'blue')
  return (
    <div className={clsx('p-3 rounded-lg text-sm border', colors.bg, colors.border)}>
      <h5 className={clsx('font-semibold mb-2', colors.title)}>{setup.title}</h5>
      <ol className={clsx('list-decimal list-inside space-y-1 text-xs', colors.text)}>
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
  const bgClass = success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
  const Icon = success ? CheckCircle2 : AlertCircle
  return (
    <div className={clsx('p-3 rounded-lg text-sm', bgClass)}>
      <Icon size={14} className="inline mr-2" />
      {message}
    </div>
  )
}
