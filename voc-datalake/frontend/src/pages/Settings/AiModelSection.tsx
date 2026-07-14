/**
 * @fileoverview AI model selection section for Settings (issue #96).
 *
 * Admins can pin AI generation features to one Bedrock model from a curated
 * allowlist served by the backend, or leave it on Automatic where each
 * feature uses its own tuned default. Free-form model IDs are rejected
 * server-side (and the PUT is admin-gated server-side too).
 *
 * Labels/descriptions are translated client-side under the model's stable
 * `key`, falling back to the server-provided English strings for any model
 * the locale files don't know yet.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Cpu, CheckCircle2, Loader2, AlertCircle } from 'lucide-react'
import clsx from 'clsx'
import { api } from '../../api/client'

interface AiModelSectionProps {
  readonly apiEndpoint: string
}

interface ModelOptionProps {
  readonly id: string | null
  readonly label: string
  readonly description: string
  readonly monoId?: string
  readonly selected: boolean
  readonly onSelect: () => void
}

function ModelOption({ id, label, description, monoId, selected, onSelect }: ModelOptionProps) {
  return (
    <label
      className={clsx(
        'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
        selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300',
      )}
    >
      <input
        type="radio"
        name="ai-model"
        value={id ?? 'automatic'}
        checked={selected}
        onChange={onSelect}
        className="mt-1"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{label}</span>
        <span className="block text-xs text-gray-500">{description}</span>
        {monoId && <span className="block text-xs text-gray-400 font-mono truncate">{monoId}</span>}
      </span>
    </label>
  )
}

export default function AiModelSection({ apiEndpoint }: AiModelSectionProps) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear the "Saved" badge timer on unmount so it can't set state after.
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['model-settings'],
    queryFn: () => api.getModelSettings(),
    enabled: apiEndpoint.length > 0,
  })

  const saveMutation = useMutation({
    mutationFn: (modelId: string | null) => api.saveModelSettings(modelId),
    onSuccess: () => {
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 2000)
      void queryClient.invalidateQueries({ queryKey: ['model-settings'] })
    },
  })

  if (apiEndpoint.length === 0) return null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Cpu size={18} className="text-blue-600" />
          {t('aiModel.title')}
        </h2>
        {saved && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 size={14} /> {t('aiModel.saved')}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">{t('aiModel.intro')}</p>

      <AiModelSectionBody
        data={data}
        isLoading={isLoading}
        isError={isError}
        isSaving={saveMutation.isPending}
        onSelect={(modelId) => saveMutation.mutate(modelId)}
      />
      {saveMutation.isError && (
        <p className="text-xs text-red-600 mt-2" role="alert">{t('aiModel.saveFailed')}</p>
      )}
    </div>
  )
}

interface AiModelSectionBodyProps {
  readonly data: Awaited<ReturnType<typeof api.getModelSettings>> | undefined
  readonly isLoading: boolean
  readonly isError: boolean
  readonly isSaving: boolean
  readonly onSelect: (modelId: string | null) => void
}

function AiModelSectionBody({ data, isLoading, isError, isSaving, onSelect }: AiModelSectionBodyProps) {
  const { t } = useTranslation('settings')

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600" role="alert">
        <AlertCircle size={16} /> {t('aiModel.loadFailed')}
      </div>
    )
  }
  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> {t('aiModel.loading')}
      </div>
    )
  }
  return (
    <fieldset className="space-y-2" disabled={isSaving}>
      <legend className="sr-only">{t('aiModel.legend')}</legend>
      <ModelOption
        id={null}
        label={t('aiModel.automatic.label')}
        description={t('aiModel.automatic.description')}
        selected={data.model_id === null}
        onSelect={() => onSelect(null)}
      />
      {data.available_models.map((model) => (
        <ModelOption
          key={model.id}
          id={model.id}
          label={t(`aiModel.models.${model.key}.label`, { defaultValue: model.label })}
          description={t(`aiModel.models.${model.key}.description`, { defaultValue: model.description })}
          monoId={model.id}
          selected={data.model_id === model.id}
          onSelect={() => onSelect(model.id)}
        />
      ))}
    </fieldset>
  )
}
