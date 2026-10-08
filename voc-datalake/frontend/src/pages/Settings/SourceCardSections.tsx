/**
 * @fileoverview The expanded SourceCard's webhook, credentials and setup sections.
 * @module pages/Settings/SourceCardSections
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Save, Check, AlertCircle, Loader2, Copy, ExternalLink, Eye, EyeOff, CheckCircle2, Webhook, Key, TestTube,
} from 'lucide-react'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import clsx from 'clsx'
import { ConfigFieldOptions } from '../Scrapers/PluginConfigParts'
import type { ConfigField, SetupInfo, WebhookInfo } from '../../plugins/types'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

// ============================================
// Helper Functions
// ============================================

function getInstructionColors(color: string): { bg: string; border: string; title: string; text: string } {
  if (color === 'blue') return { bg: 'bg-info-subtle', border: 'border-info/30', title: 'text-info', text: 'text-text' }
  if (color === 'orange') return { bg: 'bg-warn-subtle', border: 'border-warn/30', title: 'text-warn', text: 'text-text' }
  if (color === 'green') return { bg: 'bg-ok-subtle', border: 'border-ok/30', title: 'text-ok', text: 'text-text' }
  return { bg: 'bg-bg-accent', border: 'border-border', title: 'text-text-strong', text: 'text-text' }
}

function getSaveButtonIcon(isPending: boolean, saveSuccess: boolean): React.ReactElement {
  if (isPending) return <Loader2 size={14} className="animate-spin" />
  if (saveSuccess) return <Check size={14} />
  return <Save size={14} />
}

function getSaveButtonText(
  saveSuccess: boolean, t: (key: string) => string
): { full: string; short: string } {
  if (saveSuccess) return { full: t('sourceCard.saved'), short: t('sourceCard.saved') }
  return { full: t('sourceCard.saveToSecrets'), short: t('sourceCard.save') }
}

/**
 * Whether `Save to Secrets Manager` is available, and if not, whether to say why.
 *
 * A helper rather than two expressions inline, so the admin reason and the two
 * ordinary ones are decided in one place: a `title` that outlived its condition
 * would tell a non-admin their access was refused while the button worked, or the
 * reverse. (It also keeps `CredentialsSection` under the complexity limit.)
 *
 * `title` is set ONLY for the admin case. Pending and empty-form are transient and
 * evident from the form itself; the 403 behind `PUT /integrations/{source}/credentials`
 * is neither, and is the one a user cannot otherwise discover — that mutation has no
 * `onError`, so before this gate the refusal rendered nothing at all.
 */
function getSaveButtonState(
  isPending: boolean, hasCredentials: boolean, isAdmin: boolean
): { disabled: boolean; title?: string } {
  if (!isAdmin) return { disabled: true, title: ADMIN_ONLY_TITLE }
  return { disabled: isPending || !hasCredentials }
}

// ============================================
// Main Component
// ============================================

interface WebhooksSectionProps {
  readonly webhooks: WebhookInfo[]
  readonly sourceKey: string
  readonly webhookBaseUrl: string
  readonly copiedUrl: string | null
  readonly onCopy: (text: string, id: string) => void
}

export function WebhooksSection({ webhooks, sourceKey, webhookBaseUrl, copiedUrl, onCopy }: WebhooksSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div>
      <h4 className="text-sm font-semibold text-text mb-2 sm:mb-3 flex items-center gap-2">
        <Webhook size={16} /> {t('sourceCard.webhooks')}
      </h4>
      <div className="space-y-2 sm:space-y-3">
        {webhooks.map((webhook, idx) => {
          const webhookUrl = `${webhookBaseUrl}${sourceKey}`
          const webhookId = `${sourceKey}-${idx}`
          return (
            <div key={idx} className="bg-bg-accent p-2 sm:p-3 rounded-lg">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <span className="font-medium text-xs sm:text-sm">{webhook.name}</span>
                {webhook.docUrl && (
                  <a href={webhook.docUrl} target="_blank" rel="noopener noreferrer" className="text-xs link flex items-center gap-1">
                    <ExternalLink size={12} /> {t('sourceCard.docs')}
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-bg-elevated px-2 py-1.5 rounded-sm border border-border overflow-x-auto">{webhookUrl}</code>
                <button
                  type="button"
                  onClick={() => onCopy(webhookUrl, webhookId)}
                  aria-label={t('sourceCard.copyWebhookUrl')}
                  title={t('sourceCard.copyWebhookUrl')}
                  className="btn btn-secondary p-1.5 sm:p-2 flex-shrink-0"
                >
                  {copiedUrl === webhookId ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                </button>
              </div>
              <p className="text-xs text-muted mt-1.5 sm:mt-2">{t('sourceCard.events', { events: webhook.events.join(', ') })}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface CredentialsSectionProps {
  readonly fields: ConfigField[]
  readonly credentials: Record<string, string>
  readonly showSecrets: boolean
  readonly sourceStatus: { configured?: boolean } | undefined
  readonly saveSuccess: boolean
  /** `PUT /integrations/{source}/credentials` behind Save is admin-gated
   *  server-side, so Save is disabled for a non-admin rather than issuing a
   *  request that 403s. Only Save: the fields stay editable (a non-admin can
   *  already read them) and `POST /integrations/{source}/test` is not gated. */
  readonly isAdmin: boolean
  readonly testMutation: { isPending: boolean; data?: { success: boolean; message?: string; error?: string }; mutate: () => void }
  readonly updateCredentialsMutation: { isPending: boolean; mutate: (creds: Record<string, string>) => void }
  readonly onCredentialsChange: (creds: Record<string, string>) => void
  readonly onToggleSecrets: () => void
}

export function CredentialsSection({
  fields, credentials, showSecrets, sourceStatus, saveSuccess, isAdmin, testMutation, updateCredentialsMutation,
  onCredentialsChange, onToggleSecrets
}: CredentialsSectionProps) {
  const { t } = useTranslation('settings')
  const saveIcon = getSaveButtonIcon(updateCredentialsMutation.isPending, saveSuccess)
  const saveText = getSaveButtonText(saveSuccess, t)
  const saveButtonClass = saveSuccess ? 'bg-ok text-ok-fg border-ok' : 'btn-primary'
  const saveState = getSaveButtonState(
    updateCredentialsMutation.isPending, Object.keys(credentials).length > 0, isAdmin
  )

  return (
    <div>
      <h4 className="text-sm font-semibold text-text mb-2 sm:mb-3 flex items-center gap-2">
        <Key size={16} /> {t('sourceCard.credentials')}
      </h4>
      <div className="space-y-3 sm:space-y-4">
        <div className="grid gap-3 sm:gap-4">
          {fields.map((field) => (
            <CredentialField
              key={field.key}
              field={field}
              value={credentials[field.key] ?? ''}
              showSecrets={showSecrets}
              onChange={(value) => onCredentialsChange({ ...credentials, [field.key]: value })}
            />
          ))}
        </div>

        <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-2 py-2">
          <button onClick={onToggleSecrets} className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2">
            {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
            {showSecrets ? t('sourceCard.hide') : t('sourceCard.show')}
          </button>
          <button
            onClick={() => updateCredentialsMutation.mutate(credentials)}
            disabled={saveState.disabled}
            title={saveState.title}
            className={clsx('btn flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2', saveButtonClass)}
          >
            {saveIcon}
            <span className="hidden xs:inline">{saveText.full}</span>
            <span className="xs:hidden">{saveText.short}</span>
          </button>
          <button
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending || !sourceStatus?.configured}
            className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2"
          >
            {testMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
            {t('sourceCard.test')}
          </button>
        </StickyActionBar>

        {testMutation.data && (
          <TestResultMessage success={testMutation.data.success} message={[testMutation.data.message, testMutation.data.error].find((m) => m !== undefined && m !== '') ?? t('sourceCard.unknownResult')} />
        )}
      </div>
    </div>
  )
}

interface CredentialFieldProps {
  readonly field: ConfigField
  readonly value: string
  readonly showSecrets: boolean
  readonly onChange: (value: string) => void
}

function CredentialLabel({ field }: { readonly field: ConfigField }) {
  return (
    <label className="block text-xs sm:text-sm font-medium text-text mb-1">
      {field.label}
      {field.required && <span className="text-danger ml-1">*</span>}
    </label>
  )
}

function CredentialField({ field, value, showSecrets, onChange }: CredentialFieldProps) {
  const { t } = useTranslation('settings')
  const placeholder = field.placeholder ?? t('sourceCard.enterField', { field: field.label.toLowerCase() })
  const inputType = field.type === 'password' && !showSecrets ? 'password' : 'text'

  if (field.type === 'textarea') {
    return (
      <div>
        <CredentialLabel field={field} />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input text-xs sm:text-sm min-h-[80px]"
        />
      </div>
    )
  }

  if (field.type === 'select' && field.options) {
    return (
      <div>
        <CredentialLabel field={field} />
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="select text-xs sm:text-sm"
        >
          <ConfigFieldOptions placeholder={t('sourceCard.selectOption')} options={field.options} />
        </select>
      </div>
    )
  }

  return (
    <div>
      <CredentialLabel field={field} />
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input text-xs sm:text-sm"
      />
    </div>
  )
}

interface TestResultMessageProps {
  readonly success: boolean
  readonly message: string
}

function TestResultMessage({ success, message }: TestResultMessageProps) {
  const bgClass = success ? 'bg-ok-subtle text-ok' : 'bg-danger-subtle text-danger'
  const Icon = success ? CheckCircle2 : AlertCircle
  return (
    <div className={clsx('p-2 sm:p-3 rounded-lg text-xs sm:text-sm', bgClass)}>
      <Icon size={14} className="inline mr-1.5 sm:mr-2" />
      {message}
    </div>
  )
}

interface SetupInstructionsSectionProps {
  readonly setup: SetupInfo
}

export function SetupInstructionsSection({ setup }: SetupInstructionsSectionProps) {
  const colors = getInstructionColors(setup.color ?? 'blue')

  return (
    <div className={clsx('p-2 sm:p-3 rounded-lg text-xs sm:text-sm border', colors.bg, colors.border)}>
      <h5 className={clsx('font-semibold mb-2', colors.title)}>{setup.title}</h5>
      <ol className={clsx('list-decimal list-inside space-y-1 text-xs', colors.text)}>
        {setup.steps.map((step, i) => <li key={i}>{step}</li>)}
      </ol>
    </div>
  )
}
