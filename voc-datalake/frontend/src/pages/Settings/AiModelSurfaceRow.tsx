/**
 * @fileoverview One surface row of the Settings AI models card: the DRAFT
 * choice, a Test button for the model that draft resolves to (Automatic
 * included), the last test result, and Save / Discard while the draft differs
 * from what is stored. Nothing is saved until Save.
 */
import { useTranslation } from 'react-i18next'
import { CheckCircle2, FlaskConical, Save, Undo2 } from 'lucide-react'
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
  /** The model the draft resolves to (what Test and the pill are about). */
  readonly resolvedId: string
  readonly resolvedLabel: string
  readonly models: readonly SurfaceRowModel[]
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
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.label}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={props.testDisabled}
            title={t('aiModel.test.testTitle', { model: props.resolvedLabel, surface: surfaceLabel })}
            onClick={props.onTest}
          >
            <FlaskConical size={14} aria-hidden="true" /> {t('aiModel.test.test')}
          </button>
        </div>
      </div>
      <RowStatus {...props} />
    </div>
  )
}

function RowStatus({ result, testing, dirty, saving, justSaved, onSave, onDiscard }: SurfaceRowProps) {
  const { t } = useTranslation('settings')
  if (!result && !testing && !dirty && !justSaved) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <ModelTestPill result={result} testing={testing} />
      <div className="flex items-center gap-2">
        {justSaved && (
          <span className="text-xs text-ok flex items-center gap-1">
            <CheckCircle2 size={14} aria-hidden="true" /> {t('aiModel.saved')}
          </span>
        )}
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
