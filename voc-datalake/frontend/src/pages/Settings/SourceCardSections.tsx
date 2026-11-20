/**
 * @fileoverview The expanded SourceCard's webhook, credentials and setup sections.
 * @module pages/Settings/SourceCardSections
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Save, Check, Loader2, Copy, ExternalLink, Eye, EyeOff, Webhook, Key,
} from 'lucide-react'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import { useAdminOnlyReason } from '../../hooks/useAdminOnlyReason'
import { ConfigFieldOptions } from '../Scrapers/PluginConfigParts'
import type { ConfigField, SetupInfo, WebhookInfo } from '../../plugins/types'
import SavedStatus from '../../components/SavedStatus/SavedStatus'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

// ============================================
// Helper Functions
// ============================================


/**
 * Whether `Save to Secrets Manager` is available, and if not, whether to say why.
 *
 * A helper rather than two expressions inline, so the admin reason and the two
 * ordinary ones are decided in one place: a reason that outlived its condition
 * would tell a non-admin their access was refused while the button worked, or the
 * reverse. (It also keeps `CredentialsSection` under the complexity limit.)
 *
 * The reason (`common:adminOnly`, the button's Tooltip and description) is given ONLY
 * for the admin case, where the button stays focusable (`aria-disabled`, 7.51.01's
 * pattern). Pending and empty-form are transient and evident from the form itself
 * (`disabled`); the 403 behind `PUT /integrations/{source}/credentials` is neither,
 * and is the one a user cannot otherwise discover — that mutation has no `onError`,
 * so before this gate the refusal rendered nothing at all.
 */
function getSaveButtonState(
  isPending: boolean, hasCredentials: boolean, isAdmin: boolean
): { disabled: boolean; adminGated: boolean } {
  if (!isAdmin) return { disabled: false, adminGated: true }
  return { disabled: isPending || !hasCredentials, adminGated: false }
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
                <Tooltip kind="label" content={t('sourceCard.copyWebhookUrl')}>
                  <button
                    type="button"
                    onClick={() => onCopy(webhookUrl, webhookId)}
                    aria-label={t('sourceCard.copyWebhookUrl')}
                    className="btn btn-secondary p-1.5 sm:p-2 flex-shrink-0"
                  >
                    {copiedUrl === webhookId ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
                  </button>
                </Tooltip>
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
  readonly saveSuccess: boolean
  /** `PUT /integrations/{source}/credentials` behind Save is admin-gated
   *  server-side, so Save is disabled for a non-admin rather than issuing a
   *  request that 403s. Only Save: the fields stay editable (a non-admin can
   *  already read them). */
  readonly isAdmin: boolean
  readonly updateCredentialsMutation: { isPending: boolean; mutate: (creds: Record<string, string>) => void }
  readonly onCredentialsChange: (creds: Record<string, string>) => void
  readonly onToggleSecrets: () => void
  /** What comes before the fields (the GitHub Issues card's "Sign in with", which decides the fields shown). */
  readonly lead?: ReactNode
}

export function CredentialsSection({
  fields, credentials, showSecrets, saveSuccess, isAdmin, updateCredentialsMutation,
  onCredentialsChange, onToggleSecrets, lead,
}: CredentialsSectionProps) {
  const { t } = useTranslation('settings')
  const saveState = getSaveButtonState(
    updateCredentialsMutation.isPending, Object.keys(credentials).length > 0, isAdmin
  )
  const adminOnly = useAdminOnlyReason(isAdmin)

  return (
    <div>
      <h4 className="text-sm font-semibold text-text mb-2 sm:mb-3 flex items-center gap-2">
        <Key size={16} /> {t('sourceCard.credentials')}
      </h4>
      <div className="space-y-3 sm:space-y-4">
        <div className="grid gap-3 sm:gap-4">
          {lead}
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

        <StickyActionBar variant="footer" className="flex flex-wrap items-center gap-2 py-2">
          <button onClick={onToggleSecrets} className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2">
            {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
            {showSecrets ? t('sourceCard.hide') : t('sourceCard.show')}
          </button>
          <Tooltip kind="description" content={adminOnly}>
            <button
              onClick={saveState.adminGated ? undefined : () => updateCredentialsMutation.mutate(credentials)}
              disabled={saveState.disabled}
              aria-disabled={saveState.adminGated ? true : undefined}
              className="btn btn-primary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2"
            >
              {updateCredentialsMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              <span className="hidden xs:inline">{t('sourceCard.saveToSecrets')}</span>
              <span className="xs:hidden">{t('sourceCard.save')}</span>
            </button>
          </Tooltip>
          {/* The one Saved (components/SavedStatus): until the next edit of these fields. */}
          <SavedStatus saved={saveSuccess} />
        </StickyActionBar>
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

interface SetupInstructionsSectionProps {
  readonly setup: SetupInfo
}

export function SetupInstructionsSection({ setup }: SetupInstructionsSectionProps) {
  // One neutral panel for every plugin. The manifest's `setup.color` (blue / orange /
  // green per plugin) is identity, not a state, so it no longer paints the panel
  // (labels vs status, design-system rule 15).
  return (
    <div className="p-2 sm:p-3 rounded-lg text-xs sm:text-sm border bg-bg-accent border-border">
      <h5 className="font-semibold mb-2 text-text-strong">{setup.title}</h5>
      <ol className="list-decimal list-inside space-y-1 text-xs text-text">
        {setup.steps.map((step, i) => <li key={i}>{step}</li>)}
      </ol>
    </div>
  )
}
