/**
 * @fileoverview Per-surface AI model selection for Settings (issue #96).
 *
 * Admins pick which allowlisted Bedrock model powers each AI *surface* (chat,
 * documents, prototypes, feedback enrichment, utilities), or leave a surface
 * on Automatic to use its tuned default. This is the per-surface alternative
 * to a single global model toggle: enrichment can stay on cheap Haiku while
 * the AI assistant (surface key `chat`: the floating page-aware assistant and
 * the chat page) runs on Sonnet 5.5 and prototypes on Opus 5.5.
 *
 * Draft, test, then save: changing a select only changes the row's DRAFT. The
 * row's Test button sends one request to exactly the model the draft resolves
 * to (POST /settings/model/test, no fallback), and Save writes it. Saving a
 * model whose last test was not `available` (or that was never tested) asks
 * for confirmation, but is allowed. "Test all models" runs every model in turn.
 *
 * Free-form model IDs are rejected server-side, and the PUT and the test are
 * admin-gated server-side too (not just hidden in the UI).
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
import { Cpu, Loader2, AlertCircle } from 'lucide-react'
import { api } from '../../api/client'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import AiModelSurfaceRow from './AiModelSurfaceRow'
import ModelTestAllPanel from './ModelTestAllPanel'
import { useModelTestStatusLabel } from './modelTestStatus'
import { useModelTests } from './useModelTests'
import type { ModelTests } from './useModelTests'
import type { ModelTestStatus } from '../../api/modelTestSchema'

interface AiModelSectionProps {
  readonly apiEndpoint: string
  /** Card renders only for admins — the backend gates the PUT server-side too. */
  readonly isAdmin: boolean
}

type ModelSettings = Awaited<ReturnType<typeof api.getModelSettings>>

/** A save waiting for the admin to confirm an untested or failing model. */
interface PendingSave {
  readonly surface: string
  readonly modelId: string | null
  readonly resolvedId: string
}

export default function AiModelSection({ apiEndpoint, isAdmin }: AiModelSectionProps) {
  const { t } = useTranslation('settings')
  const enabled = isAdmin && apiEndpoint.length > 0

  const { data, isLoading, isError } = useQuery({
    queryKey: ['model-settings'],
    queryFn: () => api.getModelSettings(),
    enabled,
  })

  if (!enabled) return null

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Cpu size={18} className="text-accent" />
        <h2 className="text-lg font-semibold">{t('aiModel.title')}</h2>
      </div>
      <p className="text-xs text-muted mb-4">{t('aiModel.intro')}</p>
      <AiModelSectionBody data={data} isLoading={isLoading} isError={isError} />
    </div>
  )
}

interface AiModelSectionBodyProps {
  readonly data: ModelSettings | undefined
  readonly isLoading: boolean
  readonly isError: boolean
}

function AiModelSectionBody({ data, isLoading, isError }: AiModelSectionBodyProps) {
  const { t } = useTranslation('settings')

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-danger" role="alert">
        <AlertCircle size={16} /> {t('aiModel.loadFailed')}
      </div>
    )
  }
  if (isLoading || !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> {t('aiModel.loading')}
      </div>
    )
  }
  return <AiModelEditor data={data} />
}

const SAVED_BADGE_MS = 2000

/** Saved-badge timer: shows `surface` as just saved for two seconds. */
function useJustSaved(): [string | null, (surface: string) => void] {
  const [savedSurface, setSavedSurface] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Clear the timer on unmount so it can't set state afterwards.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const mark = (surface: string) => {
    setSavedSurface(surface)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSavedSurface(null), SAVED_BADGE_MS)
  }
  return [savedSurface, mark]
}

function AiModelEditor({ data }: { readonly data: ModelSettings }) {
  const { t } = useTranslation('settings')
  const statusLabel = useModelTestStatusLabel()
  const queryClient = useQueryClient()
  const tests = useModelTests()
  // Surface key -> draft select value ('' = Automatic). Absent = no draft.
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({})
  const [pending, setPending] = useState<PendingSave | null>(null)
  const [savedSurface, markSaved] = useJustSaved()

  const dropDraft = (surface: string) =>
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== surface)))

  const saveMutation = useMutation({
    mutationFn: ({ surface, modelId }: PendingSave) => api.saveModelSettings(surface, modelId),
    onSuccess: async (_result, { surface }) => {
      markSaved(surface)
      await queryClient.invalidateQueries({ queryKey: ['model-settings'] })
      dropDraft(surface)
    },
  })

  // Model id → display label (product name, served by the backend).
  const labelForId = new Map(data.available_models.map((model) => [model.id, model.label]))
  const labelOf = (id: string) => labelForId.get(id) ?? id

  // 🔑 The deployment-wide pin (`settings.model_id`, seeded by
  // `-c defaultModelId=<id>`) outranks every surface's built-in default in
  // shared/model_config.py: per-surface override > global pin > SURFACE_DEFAULTS.
  // Labelling Automatic from `surface.default_id` alone — which is what this did
  // before #275 — made a pinned deployment advertise a model it never invokes,
  // and invited an admin to "correct" it by explicitly selecting the advertised
  // model, which in a workshop account cannot be invoked at all. Truthiness, not
  // `??`: the field can arrive absent or as '' from an older payload, and
  // neither is a pin. Tests: 'names the deployment-wide pin in every Automatic
  // option' and 'ignores an empty-string pin and keeps the surface default'.
  const pinnedId = typeof data.model_id === 'string' && data.model_id !== '' ? data.model_id : null

  const requestSave = (save: PendingSave) => {
    if (tests.results[save.resolvedId]?.status === 'available') {
      saveMutation.mutate(save)
    } else {
      setPending(save)
    }
  }

  return (
    <>
      <fieldset className="space-y-3">
        <legend className="sr-only">{t('aiModel.title')}</legend>
        {data.surfaces.map((surface) => {
          // What Automatic actually resolves to for this surface. The pin does not
          // touch `selected`: a stored per-surface choice still outranks it.
          const automaticId = pinnedId ?? surface.default_id
          const stored = surface.selected ?? ''
          const draft = drafts[surface.key] ?? stored
          const resolvedId = draft === '' ? automaticId : draft
          return (
            <AiModelSurfaceRow
              key={surface.key}
              surfaceKey={surface.key}
              draft={draft}
              dirty={draft !== stored}
              automaticLabel={labelOf(automaticId)}
              resolvedId={resolvedId}
              resolvedLabel={labelOf(resolvedId)}
              models={data.available_models}
              result={tests.results[resolvedId]}
              testing={tests.testing.has(resolvedId)}
              testDisabled={isBusy(tests, resolvedId)}
              saving={saveMutation.isPending}
              justSaved={savedSurface === surface.key}
              onDraft={(value) => setDrafts((current) => ({ ...current, [surface.key]: value }))}
              onTest={() => void tests.runTest(resolvedId)}
              onSave={() => requestSave({ surface: surface.key, modelId: draft === '' ? null : draft, resolvedId })}
              onDiscard={() => dropDraft(surface.key)}
            />
          )
        })}
      </fieldset>
      {saveMutation.isError && (
        <p className="text-xs text-danger mt-2" role="alert">{t('aiModel.saveFailed')}</p>
      )}
      <ModelTestAllPanel models={data.available_models} tests={tests} />
      <SaveConfirm
        pending={pending}
        modelLabel={pending ? labelOf(pending.resolvedId) : ''}
        lastStatus={pending ? tests.results[pending.resolvedId]?.status : undefined}
        statusLabel={statusLabel}
        onConfirm={(save) => {
          setPending(null)
          saveMutation.mutate(save)
        }}
        onCancel={() => setPending(null)}
      />
    </>
  )
}

/** A row's Test is off while its model is being tested or "Test all" is running. */
function isBusy(tests: ModelTests, modelId: string): boolean {
  return tests.allProgress !== null || tests.testing.has(modelId)
}

interface SaveConfirmProps {
  readonly pending: PendingSave | null
  readonly modelLabel: string
  /** The model's last test status this visit; undefined = never tested. */
  readonly lastStatus: ModelTestStatus | undefined
  readonly statusLabel: ReturnType<typeof useModelTestStatusLabel>
  readonly onConfirm: (save: PendingSave) => void
  readonly onCancel: () => void
}

function SaveConfirm({ pending, modelLabel, lastStatus, statusLabel, onConfirm, onCancel }: SaveConfirmProps) {
  const { t } = useTranslation('settings')
  if (!pending) return null
  const surface = t(`aiModel.surfaces.${pending.surface}.label`)
  const message = lastStatus
    ? t('aiModel.test.confirm.failed', { model: modelLabel, surface, status: statusLabel(lastStatus) })
    : t('aiModel.test.confirm.untested', { model: modelLabel, surface })
  return (
    <ConfirmModal
      isOpen
      variant="warning"
      title={t('aiModel.test.confirm.title')}
      message={message}
      confirmLabel={t('aiModel.test.confirm.save')}
      onConfirm={() => onConfirm(pending)}
      onCancel={onCancel}
    />
  )
}
