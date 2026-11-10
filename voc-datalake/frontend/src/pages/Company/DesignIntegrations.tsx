/**
 * @fileoverview Figma / GitHub tokens for the design system — write-only.
 *
 * Tokens go to Secrets Manager through `PUT /settings/design-system/integrations`
 * and are never read back: the API only says whether each one is configured, so
 * the fields always start empty and an empty field means "leave unchanged".
 *
 * @module pages/Company/DesignIntegrations
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleDashed, KeyRound } from 'lucide-react'
import { designSystemApi, designSystemKey } from '../../api/designSystemApi'
import type { DesignSystem, IntegrationsStatus } from '../../api/designSystemApi'
import { GroupLabel, SaveRow } from './ContextParts'

type Provider = keyof IntegrationsStatus

const PROVIDERS: readonly Provider[] = ['figma', 'github']

export default function DesignIntegrations({ status }: Readonly<{ status: IntegrationsStatus }>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [tokens, setTokens] = useState<Record<Provider, string>>({ figma: '', github: '' })
  const save = useMutation({
    mutationFn: () => designSystemApi.saveIntegrations({
      ...(tokens.figma.trim() ? { figma_token: tokens.figma.trim() } : {}),
      ...(tokens.github.trim() ? { github_token: tokens.github.trim() } : {}),
    }),
    onSuccess: (integrations) => {
      setTokens({ figma: '', github: '' })
      queryClient.setQueryData(designSystemKey(), (current: DesignSystem | undefined) =>
        current ? { ...current, integrations } : current)
    },
  })
  const anyEntered = PROVIDERS.some((p) => tokens[p].trim() !== '')

  return (
    <div>
      <GroupLabel>{t('designSystem.integrations')}</GroupLabel>
      <p className="text-xs text-muted mb-3">{t('designSystem.integrationsHint')}</p>
      <div className="space-y-3">
        {PROVIDERS.map((provider) => (
          <div key={provider} className="flex flex-col sm:flex-row sm:items-center gap-2">
            <label htmlFor={`design-token-${provider}`} className="text-sm font-medium text-text sm:w-28 flex items-center gap-1.5">
              <KeyRound size={14} className="text-muted" /> {t(`designSystem.providers.${provider}`)}
            </label>
            <input
              id={`design-token-${provider}`}
              type="password"
              autoComplete="off"
              value={tokens[provider]}
              placeholder={status[provider] ? t('designSystem.tokenReplacePlaceholder') : t('designSystem.tokenPlaceholder')}
              onChange={(e) => setTokens((c) => ({ ...c, [provider]: e.target.value }))}
              className="input flex-1 font-mono"
            />
            {status[provider] ? (
              <span className="badge badge-ok flex items-center gap-1"><CheckCircle2 size={12} /> {t('designSystem.configured')}</span>
            ) : (
              <span className="badge badge-muted flex items-center gap-1"><CircleDashed size={12} /> {t('designSystem.notConfigured')}</span>
            )}
          </div>
        ))}
      </div>
      <SaveRow
        onSave={() => save.mutate()}
        pending={save.isPending}
        saved={save.isSuccess}
        failed={save.isError}
        disabled={!anyEntered}
        label={t('designSystem.saveTokens')}
      />
    </div>
  )
}
