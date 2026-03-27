/**
 * @fileoverview Credential fields and action components for SourceCard.
 * @module pages/Settings/SourceCardFields
 */

import clsx from 'clsx'
import {
  Save, Check, AlertCircle, Loader2, Eye, EyeOff, CheckCircle2, Key, TestTube, Play,
} from 'lucide-react'
import type {
  ConfigField, SetupInfo,
} from '../../plugins/types'

function getSaveButtonIcon(isPending: boolean, saveSuccess: boolean): React.ReactElement {
  if (isPending) return <Loader2 size={14} className="animate-spin" />
  if (saveSuccess) return <Check size={14} />
  return <Save size={14} />
}

function getSaveButtonText(saveSuccess: boolean): {
  full: string;
  short: string
} {
  if (saveSuccess) return {
    full: 'Saved!',
    short: 'Saved!',
  }
  return {
    full: 'Save to Secrets Manager',
    short: 'Save',
  }
}

function getInstructionColors(color: string): {
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
  if (color === 'orange') return {
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    title: 'text-orange-900',
    text: 'text-orange-800',
  }
  if (color === 'green') return {
    bg: 'bg-green-50',
    border: 'border-green-200',
    title: 'text-green-900',
    text: 'text-green-800',
  }
  return {
    bg: 'bg-gray-50',
    border: 'border-gray-200',
    title: 'text-gray-900',
    text: 'text-gray-700',
  }
}

function buildCompleteCredentials(fields: ConfigField[], credentials: Record<string, string>): Record<string, string> {
  const completeCreds: Record<string, string> = {}
  for (const field of fields) {
    const current = field.key in credentials ? credentials[field.key] : undefined
    if (current != null && current !== '') {
      completeCreds[field.key] = current
    } else if (field.options && field.options.length > 0) {
      completeCreds[field.key] = field.options[0].value
    } else if (field.placeholder != null && field.placeholder !== '') {
      completeCreds[field.key] = field.placeholder
    }
  }
  return completeCreds
}

interface CredentialFieldProps {
  readonly field: ConfigField
  readonly value: string
  readonly showSecrets: boolean
  readonly onChange: (value: string) => void
}

export function CredentialField({
  field, value, showSecrets, onChange,
}: CredentialFieldProps) {
  const placeholder = field.placeholder ?? `Enter ${field.label.toLowerCase()}`
  const inputType = field.type === 'password' && !showSecrets ? 'password' : 'text'

  if (field.type === 'textarea') {
    return (
      <div>
        <label className="block text-xs sm:text-sm font-medium text-gray-600 mb-1">
          {field.label}{field.required === true ? <span className="text-red-500 ml-1">*</span> : null}
        </label>
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input text-xs sm:text-sm min-h-[80px]" />
      </div>
    )
  }

  if (field.type === 'select' && field.options) {
    return (
      <div>
        <label className="block text-xs sm:text-sm font-medium text-gray-600 mb-1">
          {field.label}{field.required === true ? <span className="text-red-500 ml-1">*</span> : null}
        </label>
        <select value={value} onChange={(e) => onChange(e.target.value)} className="input text-xs sm:text-sm">
          <option value="">Select...</option>
          {field.options.map((opt) => (<option key={opt.value} value={opt.value}>{opt.label}</option>))}
        </select>
      </div>
    )
  }

  return (
    <div>
      <label className="block text-xs sm:text-sm font-medium text-gray-600 mb-1">
        {field.label}{field.required === true ? <span className="text-red-500 ml-1">*</span> : null}
      </label>
      <input type={inputType} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input text-xs sm:text-sm" />
    </div>
  )
}

interface CredentialActionsProps {
  readonly showSecrets: boolean
  readonly saveSuccess: boolean
  readonly sourceStatus: { configured?: boolean } | undefined
  readonly hasIngestor: boolean
  readonly savePending: boolean
  readonly testMutation: {
    isPending: boolean;
    mutate: () => void
  }
  readonly runMutation: {
    isPending: boolean;
    mutate: () => void
  }
  readonly credentialsEmpty: boolean
  readonly onToggleSecrets: () => void
  readonly onSave: () => void
}

export function CredentialActions({
  showSecrets, saveSuccess, sourceStatus, hasIngestor, savePending, testMutation, runMutation, credentialsEmpty, onToggleSecrets, onSave,
}: CredentialActionsProps) {
  const saveIcon = getSaveButtonIcon(savePending, saveSuccess)
  const saveText = getSaveButtonText(saveSuccess)
  const saveButtonClass = saveSuccess ? 'bg-green-600 text-white' : 'btn-primary'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={onToggleSecrets} className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2">
        {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
        {showSecrets ? 'Hide' : 'Show'}
      </button>
      <button onClick={onSave} disabled={savePending || credentialsEmpty} className={clsx('btn flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2', saveButtonClass)}>
        {saveIcon}
        <span className="hidden xs:inline">{saveText.full}</span>
        <span className="xs:hidden">{saveText.short}</span>
      </button>
      <button onClick={() => testMutation.mutate()} disabled={testMutation.isPending || sourceStatus?.configured !== true} className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2">
        {testMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
        Test
      </button>
      {hasIngestor ? <button onClick={() => runMutation.mutate()} disabled={runMutation.isPending} className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2">
        {runMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        Run Now
      </button> : null}
    </div>
  )
}

export function TestResultMessage({
  success, message,
}: {
  readonly success: boolean;
  readonly message: string
}) {
  const bgClass = success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
  const ResultIcon = success ? CheckCircle2 : AlertCircle
  return (
    <div className={clsx('p-2 sm:p-3 rounded-lg text-xs sm:text-sm', bgClass)}>
      <ResultIcon size={14} className="inline mr-1.5 sm:mr-2" />
      {message}
    </div>
  )
}

export function SetupInstructionsSection({ setup }: { readonly setup: SetupInfo }) {
  const colors = getInstructionColors(setup.color ?? 'blue')
  return (
    <div className={clsx('p-2 sm:p-3 rounded-lg text-xs sm:text-sm border', colors.bg, colors.border)}>
      <h5 className={clsx('font-semibold mb-2', colors.title)}>{setup.title}</h5>
      <ol className={clsx('list-decimal list-inside space-y-1 text-xs', colors.text)}>
        {setup.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
    </div>
  )
}

export interface CredentialsSectionProps {
  readonly fields: ConfigField[]
  readonly credentials: Record<string, string>
  readonly showSecrets: boolean
  readonly sourceStatus: { configured?: boolean } | undefined
  readonly saveSuccess: boolean
  readonly testMutation: {
    isPending: boolean;
    data?: {
      success: boolean;
      message?: string;
      error?: string
    };
    mutate: () => void
  }
  readonly runMutation: {
    isPending: boolean;
    data?: {
      success: boolean;
      message?: string
    };
    mutate: () => void
  }
  readonly hasIngestor: boolean
  readonly updateCredentialsMutation: {
    isPending: boolean;
    mutate: (creds: Record<string, string>) => void
  }
  readonly onCredentialsChange: (creds: Record<string, string>) => void
  readonly onToggleSecrets: () => void
}

export function CredentialsSection({
  fields, credentials, showSecrets, sourceStatus, saveSuccess, testMutation, runMutation, hasIngestor, updateCredentialsMutation, onCredentialsChange, onToggleSecrets,
}: CredentialsSectionProps) {
  const handleSave = () => {
    updateCredentialsMutation.mutate(buildCompleteCredentials(fields, credentials))
  }
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2 sm:mb-3 flex items-center gap-2"><Key size={16} /> API Credentials</h4>
      <div className="space-y-3 sm:space-y-4">
        <div className="grid gap-3 sm:gap-4">
          {fields.map((field) => (
            <CredentialField key={field.key} field={field} value={credentials[field.key] ?? ''} showSecrets={showSecrets} onChange={(value) => onCredentialsChange({
              ...credentials,
              [field.key]: value,
            })} />
          ))}
        </div>
        <CredentialActions showSecrets={showSecrets} saveSuccess={saveSuccess} sourceStatus={sourceStatus} hasIngestor={hasIngestor} savePending={updateCredentialsMutation.isPending} testMutation={testMutation} runMutation={runMutation} credentialsEmpty={Object.keys(credentials).length === 0} onToggleSecrets={onToggleSecrets} onSave={handleSave} />
        {testMutation.data ? <TestResultMessage success={testMutation.data.success} message={testMutation.data.message ?? testMutation.data.error ?? 'Unknown result'} /> : null}
        {runMutation.data ? <TestResultMessage success={runMutation.data.success} message={runMutation.data.message ?? 'Run triggered'} /> : null}
      </div>
    </div>
  )
}
