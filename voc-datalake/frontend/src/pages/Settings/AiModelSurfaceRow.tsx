/**
 * @fileoverview One surface row of the Settings AI models card: the DRAFT
 * choice, a Test button for the model that draft resolves to (Automatic
 * included), the last test result, and Save / Discard while the draft differs
 * from what is stored. Nothing is saved until Save.
 *
 * 7.65.00: the deployment's own models that declare the surface are listed last, under "Your models", and while the
 * draft resolves to one of them the row shows what the caller hands it in `details` (CustomModelDetails.tsx).
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Save, Undo2 } from 'lucide-react'
import SavedStatus from '../../components/SavedStatus/SavedStatus'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import ModelTestPill from './ModelTestPill'
import type { ModelTestResult } from '../../api/modelTestSchema'

interface SurfaceRowModel {
  readonly id: string
  readonly label: string
}

interface SurfaceRowProps {
  readonly surfaceKey: string
  /** The draft select value: '' = Automatic, else a model id. */
  readonly draft: string
  readonly dirty: boolean
  /** Label for the model Automatic resolves to — the global pin when one is deployed. */
  readonly automaticLabel: string
  /** Label of the model the draft resolves to (what Test and the pill are about). */
  readonly resolvedLabel: string
  readonly models: readonly SurfaceRowModel[]
  /** The deployment's own models that may serve this surface (`custom_models`), listed under "Your models". */
  readonly customModels?: readonly SurfaceRowModel[]
  /** Shown under the row while the draft resolves to one of the deployment's own models. */
  readonly details?: ReactNode
  /** The model tuned for this surface (its built-in default): listed first, as "Recommended". */
  readonly recommendedId: string
  readonly result: ModelTestResult | undefined
  readonly testing: boolean
  readonly testDisabled: boolean
  readonly saving: boolean
  readonly justSaved: boolean
  readonly onDraft: (value: string) => void
  readonly onTest: () => void
  readonly onSave: () => void
  readonly onDiscard: () => void
}

export default function AiModelSurfaceRow(props: SurfaceRowProps) {
  const { t } = useTranslation('settings')
  const { surfaceKey, draft, automaticLabel, models } = props
  const selectId = `ai-model-${surfaceKey}`
  const surfaceLabel = t(`aiModel.surfaces.${surfaceKey}.label`)
  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3 last:border-0 last:pb-0" data-surface={surfaceKey}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <label htmlFor={selectId} className="block text-sm font-medium text-text-strong">{surfaceLabel}</label>
          <p className="text-xs text-muted">{t(`aiModel.surfaces.${surfaceKey}.description`)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <select
            id={selectId}
            className="select w-full sm:w-64"
            value={draft}
            disabled={props.saving}
            onChange={(event) => props.onDraft(event.target.value)}
          >
            <option value="">{t('aiModel.automaticOption', { model: automaticLabel })}</option>
            <ModelOptions models={models} customModels={props.customModels ?? []} recommendedId={props.recommendedId} />
          </select>
          <Tooltip kind="description" content={t('aiModel.test.testTitle', { model: props.resolvedLabel, surface: surfaceLabel })}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={props.testDisabled}
              onClick={props.onTest}
            >
              <FlaskConical size={14} aria-hidden="true" /> {t('aiModel.test.test')}
            </button>
          </Tooltip>
        </div>
      </div>
      {props.details}
      <RowStatus {...props} />
    </div>
  )
}

interface ModelOptionsProps {
  readonly models: readonly SurfaceRowModel[]
  readonly customModels: readonly SurfaceRowModel[]
  readonly recommendedId: string
}

const options = (list: readonly SurfaceRowModel[]) => list.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)

/**
 * The explicit choices, in groups: the model tuned for this surface under
 * "Recommended", every other allowlisted model (older generations, other
 * families) under "Other models", then the deployment's own models under
 * "Your models". Without a recommended match the allowlisted models stay flat.
 */
function ModelOptions({ models, customModels, recommendedId }: ModelOptionsProps) {
  const { t } = useTranslation('settings')
  const recommended = models.filter((model) => model.id === recommendedId)
  const others = models.filter((model) => model.id !== recommendedId)
  const yours = customModels.length > 0 && <optgroup label={t('aiModel.groupCustom')}>{options(customModels)}</optgroup>
  if (recommended.length === 0) return <>{options(others)}{yours}</>
  return (
    <>
      <optgroup label={t('aiModel.groupRecommended')}>{options(recommended)}</optgroup>
      {others.length > 0 && <optgroup label={t('aiModel.groupOther')}>{options(others)}</optgroup>}
      {yours}
    </>
  )
}

function RowStatus({ result, testing, dirty, saving, justSaved, onSave, onDiscard }: SurfaceRowProps) {
  const { t } = useTranslation('settings')
  if (!result && !testing && !dirty && !justSaved) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ModelTestPill result={result} testing={testing} />
      <div className="flex items-center gap-2">
        <SavedStatus saved={justSaved} label={t('aiModel.saved')} small />
        {dirty && (
          <>
            <span className="text-xs text-warn">{t('aiModel.test.unsaved')}</span>
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={onDiscard}>
              <Undo2 size={14} aria-hidden="true" /> {t('aiModel.test.discard')}
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={onSave}>
              <Save size={14} aria-hidden="true" /> {t('aiModel.test.save')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
