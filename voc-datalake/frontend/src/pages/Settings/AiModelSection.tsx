/**
 * @fileoverview Per-surface AI model selection for Settings (issue #96).
 *
 * Admins pick which allowlisted Bedrock model powers each AI *surface* (chat,
 * documents, prototypes, feedback enrichment, utilities), or leave a surface
 * on Automatic to use its tuned default. This is the per-surface alternative
 * to a single global model toggle: enrichment can stay on cheap Haiku while
 * chat runs on Sonnet 5 and prototypes on Opus 5.
 *
 * Free-form model IDs are rejected server-side, and the PUT is admin-gated
 * server-side too (not just hidden in the UI).
 *
 * The Automatic label follows the resolver's precedence, not just the surface
 * default — see the comment on `pinnedId` below (issue #275).
 *
 * Model NAMES are product names (identical in every language), so they render
 * from the server-provided `label` and are intentionally NOT in locale files —
 * the i18n gate rejects same-as-English values. Surface labels/descriptions and
 * the surrounding chrome are translated under `aiModel.*`.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Cpu, CheckCircle2, Loader2, AlertCircle } from 'lucide-react'
import { api } from '../../api/client'

interface AiModelSectionProps {
  readonly apiEndpoint: string
  /** Card renders only for admins — the backend gates the PUT server-side too. */
  readonly isAdmin: boolean
}

type ModelSettings = Awaited<ReturnType<typeof api.getModelSettings>>

export default function AiModelSection({ apiEndpoint, isAdmin }: AiModelSectionProps) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [savedSurface, setSavedSurface] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const enabled = isAdmin && apiEndpoint.length > 0

  // Clear the "Saved" badge timer on unmount so it can't set state afterwards.
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['model-settings'],
    queryFn: () => api.getModelSettings(),
    enabled,
  })

  const saveMutation = useMutation({
    mutationFn: ({ surface, modelId }: { surface: string; modelId: string | null }) =>
      api.saveModelSettings(surface, modelId),
    onSuccess: (_result, { surface }) => {
      setSavedSurface(surface)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSavedSurface(null), 2000)
      void queryClient.invalidateQueries({ queryKey: ['model-settings'] })
    },
  })

  if (!enabled) return null

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Cpu size={18} className="text-blue-600" />
        <h2 className="text-lg font-semibold">{t('aiModel.title')}</h2>
      </div>
      <p className="text-xs text-gray-500 mb-4">{t('aiModel.intro')}</p>
      <AiModelSectionBody
        data={data}
        isLoading={isLoading}
        isError={isError}
        isSaving={saveMutation.isPending}
        savedSurface={savedSurface}
        onSelect={(surface, modelId) => saveMutation.mutate({ surface, modelId })}
      />
      {saveMutation.isError && (
        <p className="text-xs text-red-600 mt-2" role="alert">{t('aiModel.saveFailed')}</p>
      )}
    </div>
  )
}

interface AiModelSectionBodyProps {
  readonly data: ModelSettings | undefined
  readonly isLoading: boolean
  readonly isError: boolean
  readonly isSaving: boolean
  readonly savedSurface: string | null
  readonly onSelect: (surface: string, modelId: string | null) => void
}

function AiModelSectionBody({ data, isLoading, isError, isSaving, savedSurface, onSelect }: AiModelSectionBodyProps) {
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

  // Model id → display label (product name, served by the backend).
  const labelForId = new Map(data.available_models.map((model) => [model.id, model.label]))

  // 🔑 The deployment-wide pin (`settings.model_id`, seeded by
  // `-c defaultModelId=<id>`) outranks every surface's built-in default in
  // shared/model_config.py: per-surface override > global pin > SURFACE_DEFAULTS.
  // Labelling Automatic from `surface.default_id` alone — which is what this did
  // before #275 — made a pinned deployment advertise a model it never invokes,
  // and invited an admin to "correct" it by explicitly selecting the advertised
  // model, which in a workshop account cannot be invoked at all. Truthiness, not
  // `?? null`: the field can arrive absent or as '' from an older payload, and
  // neither is a pin. Tests: 'names the deployment-wide pin in every Automatic
  // option' and 'ignores an empty-string pin and keeps the surface default'.
  const pinnedId = data.model_id ? data.model_id : null

  return (
    <fieldset className="space-y-3" disabled={isSaving}>
      <legend className="sr-only">{t('aiModel.title')}</legend>
      {data.surfaces.map((surface) => {
        // What Automatic actually resolves to for this surface. The pin does not
        // touch `selected`: a stored per-surface choice still outranks it.
        const effectiveId = pinnedId ?? surface.default_id
        return (
          <SurfaceRow
            key={surface.key}
            surfaceKey={surface.key}
            selected={surface.selected}
            automaticLabel={labelForId.get(effectiveId) ?? effectiveId}
            models={data.available_models}
            justSaved={savedSurface === surface.key}
            onSelect={(modelId) => onSelect(surface.key, modelId)}
          />
        )
      })}
    </fieldset>
  )
}

interface SurfaceRowProps {
  readonly surfaceKey: string
  readonly selected: string | null
  /** Label for the model Automatic resolves to — the global pin when one is deployed. */
  readonly automaticLabel: string
  readonly models: ModelSettings['available_models']
  readonly justSaved: boolean
  readonly onSelect: (modelId: string | null) => void
}

function SurfaceRow({ surfaceKey, selected, automaticLabel, models, justSaved, onSelect }: SurfaceRowProps) {
  const { t } = useTranslation('settings')
  const selectId = `ai-model-${surfaceKey}`
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-gray-100 pb-3 last:border-0 last:pb-0">
      <div className="min-w-0">
        <label htmlFor={selectId} className="block text-sm font-medium text-gray-900">
          {t(`aiModel.surfaces.${surfaceKey}.label`)}
        </label>
        <p className="text-xs text-gray-500">{t(`aiModel.surfaces.${surfaceKey}.description`)}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {justSaved && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 size={14} /> {t('aiModel.saved')}
          </span>
        )}
        <select
          id={selectId}
          className="input py-1.5 text-sm w-full sm:w-64"
          value={selected ?? ''}
          onChange={(event) => onSelect(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">{t('aiModel.automaticOption', { model: automaticLabel })}</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>{model.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
