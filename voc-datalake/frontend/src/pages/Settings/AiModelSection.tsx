/**
 * @fileoverview AI model selection section for Settings (issue #96).
 *
 * Admins can pin every AI feature to one Bedrock model from a curated
 * allowlist served by the backend, or leave it on Automatic where each
 * feature uses its own tuned default. Free-form model IDs are rejected
 * server-side because the prompt templates are tuned for Claude.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, CheckCircle2, Loader2 } from 'lucide-react'
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
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['model-settings'],
    queryFn: () => api.getModelSettings(),
    enabled: apiEndpoint.length > 0,
  })

  const saveMutation = useMutation({
    mutationFn: (modelId: string | null) => api.saveModelSettings(modelId),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      void queryClient.invalidateQueries({ queryKey: ['model-settings'] })
    },
  })

  if (apiEndpoint.length === 0) return null

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Cpu size={18} className="text-blue-600" />
          AI Model
        </h2>
        {saved && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 size={14} /> Saved
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Pin all AI features (chat, documents, personas, categories, enrichment) to one model,
        or keep Automatic to let each feature use its tuned default. Running Lambdas pick up
        changes within a minute.
      </p>

      {isLoading || !data ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 size={16} className="animate-spin" /> Loading models...
        </div>
      ) : (
        <fieldset className="space-y-2" disabled={saveMutation.isPending}>
          <legend className="sr-only">Select AI model</legend>
          <ModelOption
            id={null}
            label="Automatic"
            description="Each feature uses its own default model (recommended)"
            selected={data.model_id === null}
            onSelect={() => saveMutation.mutate(null)}
          />
          {data.available_models.map((model) => (
            <ModelOption
              key={model.id}
              id={model.id}
              label={model.label}
              description={model.description}
              monoId={model.id}
              selected={data.model_id === model.id}
              onSelect={() => saveMutation.mutate(model.id)}
            />
          ))}
        </fieldset>
      )}
      {saveMutation.isError && (
        <p className="text-xs text-red-600 mt-2">Failed to save model selection. Try again.</p>
      )}
    </div>
  )
}
