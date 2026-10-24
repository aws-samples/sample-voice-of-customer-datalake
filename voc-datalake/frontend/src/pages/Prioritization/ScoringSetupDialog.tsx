/**
 * @fileoverview "Scoring setup": the admin editor for the workspace's prioritization
 * metrics — names, weights, directions, the words for 1 and 5, order, archive/restore and
 * ready-made templates. Saves with `base_version`; a 409 says someone else changed it.
 * @module pages/Prioritization/ScoringSetupDialog
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Plus, RotateCcw } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { SCORING_CONFIG_KEY, prioritizationConfigApi } from '../../api/prioritizationConfigApi'
import type { PrioritizationConfig, SaveConfigResult } from '../../api/prioritizationConfigApi'
import { MAX_ACTIVE_AXES, MAX_AXES } from '../../api/prioritizationAxes'
import { joinNames } from './axisText'
import {
  addAxis, archiveAxis, builtinDraftAxis, canAddAxis, draftFromAxes, draftProblems, draftShares, moveAxis, restoreAxis,
  toAxisInputs, updateAxis,
} from './scoringDraft'
import type { DraftAxis, DraftProblem } from './scoringDraft'
import { ScoringMetricEditor } from './ScoringMetricEditor'
import type { MetricActions } from './ScoringMetricEditor'
import { SCORING_TEMPLATE_IDS, TEMPLATE_TEXT, applyTemplate } from './scoringTemplates'
import type { ScoringTemplateId, TemplateChange } from './scoringTemplates'
import { SetupSavedBy } from './ScoringSetupView'
import type { ReactElement } from 'react'

const PROBLEM_TEXT: Record<DraftProblem, { readonly messageKey: `prioritization:${string}` }> = {
  missingName: { messageKey: 'prioritization:setup.problems.missingName' },
  noActive: { messageKey: 'prioritization:setup.problems.noActive' },
  tooManyActive: { messageKey: 'prioritization:setup.problems.tooManyActive' },
  tooMany: { messageKey: 'prioritization:setup.problems.tooMany' },
  noWeight: { messageKey: 'prioritization:setup.problems.noWeight' },
}

interface Working {
  readonly draft: DraftAxis[]
  /** The version the draft was read at — what the save sends as `base_version`. */
  readonly baseVersion: number
}

type Failure = Exclude<SaveConfigResult, { ok: true }>

function SaveFailure({ failure, onReload }: { readonly failure: Failure; readonly onReload: () => void }): ReactElement {
  const { t } = useTranslation('prioritization')
  const conflict = failure.kind === 'conflict'
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-3">
      <AlertTriangle size={18} className="text-danger mt-0.5 flex-shrink-0" aria-hidden="true" />
      <div className="space-y-2 min-w-0">
        <p className="text-sm text-text-strong">
          {conflict ? t('setup.conflict') : (failure.message ?? t('setup.saveFailed'))}
        </p>
        {conflict ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onReload}>
            <RotateCcw size={14} aria-hidden="true" />{t('setup.reload')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function TemplatePicker({ onPick }: { readonly onPick: (id: ScoringTemplateId) => void }): ReactElement {
  const { t } = useTranslation('prioritization')
  return (
    <section className="space-y-2" aria-labelledby="scoring-templates-title">
      <h3 id="scoring-templates-title" className="text-sm font-semibold text-text-strong">{t('setup.templatesTitle')}</h3>
      <div className="grid grid-cols-2 gap-2">
        {SCORING_TEMPLATE_IDS.map((id) => (
          <button key={id} type="button" onClick={() => onPick(id)} className="text-left rounded-lg border border-border bg-bg-elevated hover:bg-bg-hover p-3 focus-ring">
            <span className="block text-sm font-medium text-text-strong">{t(TEMPLATE_TEXT[id].nameKey)}</span>
            {/* On a phone the names alone keep the metrics in view; the confirm says what changes. */}
            <span className="hidden sm:block text-xs text-muted mt-0.5">{t(TEMPLATE_TEXT[id].descriptionKey)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function ArchivedMetrics({ archived, canRestore, onRestore }: {
  readonly archived: readonly DraftAxis[]
  readonly canRestore: boolean
  readonly onRestore: (key: string) => void
}): ReactElement | null {
  const { t } = useTranslation('prioritization')
  if (archived.length === 0) return null
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium text-text-strong focus-ring rounded-sm">
        {t('setup.archivedTitle', { archived: archived.length })}
      </summary>
      <p className="text-xs text-muted mt-2">{t('setup.archivedHint')}</p>
      <ul className="mt-2 divide-y divide-border">
        {archived.map((axis) => (
          <li key={axis.key} className="flex items-center justify-between gap-2 py-2">
            <span className="text-sm text-text min-w-0 break-words">{axis.label}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!canRestore} onClick={() => onRestore(axis.key)}>
              {t('setup.restore')}
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}

function MetricList({ draft, actions, onAdd }: {
  readonly draft: readonly DraftAxis[]
  readonly actions: MetricActions & { readonly onRestore: (key: string) => void }
  readonly onAdd: () => void
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const active = draft.filter((axis) => !axis.archived)
  const shares = draftShares(draft)
  const addable = canAddAxis(draft)
  return (
    <section className="space-y-3" aria-labelledby="scoring-metrics-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="scoring-metrics-title" className="text-sm font-semibold text-text-strong">
          {t('setup.metricsTitle', { active: active.length, max: MAX_ACTIVE_AXES })}
        </h3>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!addable} onClick={onAdd} title={addable ? undefined : t('setup.problems.tooManyActive', { max: MAX_ACTIVE_AXES })}>
          <Plus size={14} aria-hidden="true" />{t('setup.addMetric')}
        </button>
      </div>
      <ol className="space-y-3">
        {active.map((axis, index) => (
          <ScoringMetricEditor
            key={axis.key}
            axis={axis}
            index={index}
            count={active.length}
            share={shares[axis.key] ?? 0}
            actions={actions}
            defaultName={axis.builtin && axis.id !== null ? builtinDraftAxis(axis.id, t).label : ''}
          />
        ))}
      </ol>
      <ArchivedMetrics archived={draft.filter((axis) => axis.archived)} canRestore={addable} onRestore={actions.onRestore} />
    </section>
  )
}

/** The editor's working copy and the transitions on it. */
function useWorkingDraft(config: PrioritizationConfig | undefined) {
  const { t } = useTranslation('prioritization')
  const [working, setWorking] = useState<Working | null>(null)
  const newKeys = useRef(0)
  const current: Working | null = working ?? (config === undefined ? null : {
    draft: draftFromAxes(config.axes, t), baseVersion: config.configVersion,
  })
  const change = (next: (draft: DraftAxis[]) => DraftAxis[]) => {
    if (current !== null) setWorking({ ...current, draft: next(current.draft) })
  }
  const actions = {
    onEdit: (key: string, edit: Parameters<typeof updateAxis>[2]) => change((d) => updateAxis(d, key, edit)),
    onMove: (key: string, delta: -1 | 1) => change((d) => moveAxis(d, key, delta)),
    onArchive: (key: string) => change((d) => archiveAxis(d, key)),
    onRestore: (key: string) => change((d) => restoreAxis(d, key)),
  }
  const add = () => {
    newKeys.current += 1
    change((d) => addAxis(d, `new-${String(newKeys.current)}`))
  }
  return { current, actions, add, replace: (draft: DraftAxis[]) => change(() => draft), reset: () => setWorking(null) }
}

export default function ScoringSetupDialog({ onClose, onSaved }: {
  readonly onClose: () => void
  /** Called after a save landed, so the page re-reads the board with the new setup. */
  readonly onSaved: () => void
}): ReactElement {
  const { t, i18n } = useTranslation('prioritization')
  const titleId = useId()
  const configQuery = useQuery({ queryKey: SCORING_CONFIG_KEY, queryFn: () => prioritizationConfigApi.getConfig() })
  const { current, actions, add, replace, reset } = useWorkingDraft(configQuery.data)
  const [pendingTemplate, setPendingTemplate] = useState<(TemplateChange & { readonly id: ScoringTemplateId }) | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const save = useMutation({
    mutationFn: (value: Working) => prioritizationConfigApi.saveConfig(toAxisInputs(value.draft, t), value.baseVersion),
    onSuccess: (result) => {
      if (!result.ok) {
        setFailure(result)
        return
      }
      onSaved()
      onClose()
    },
  })
  const problems = current === null ? [] : draftProblems(current.draft)
  const reload = () => {
    setFailure(null)
    reset()
    void configQuery.refetch()
  }
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-3xl max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="min-w-0">
          <h2 id={titleId} className="dialog-title">{t('setup.title')}</h2>
          <p className="dialog-description">{t('setup.description')}</p>
        </div>
        <DialogClose onClick={onClose} className="flex-shrink-0" />
      </div>
      <div className="dialog-body space-y-5 overflow-y-auto">
        {current === null ? (
          <div role="status" className="space-y-3" aria-label={t('setup.loading')}>
            {[0, 1, 2].map((n) => <div key={n} className="h-24 rounded-lg bg-bg-hover animate-pulse" />)}
          </div>
        ) : (
          <>
            <TemplatePicker onPick={(id) => setPendingTemplate({ ...applyTemplate(current.draft, id, t), id })} />
            <MetricList draft={current.draft} actions={actions} onAdd={add} />
          </>
        )}
        {problems.length > 0 ? (
          <ul role="status" className="text-sm text-warn space-y-1">
            {problems.map((problem) => <li key={problem}>{t(PROBLEM_TEXT[problem].messageKey, { max: MAX_ACTIVE_AXES, total: MAX_AXES })}</li>)}
          </ul>
        ) : null}
        {failure === null ? null : <SaveFailure failure={failure} onReload={reload} />}
      </div>
      <div className="dialog-footer justify-between flex-wrap gap-2">
        <SetupSavedBy config={configQuery.data} />
        <div className="flex items-center gap-2 ml-auto">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('setup.cancel')}</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={current === null || problems.length > 0 || save.isPending}
            onClick={() => { if (current !== null) { setFailure(null); save.mutate(current) } }}
          >
            {save.isPending ? t('setup.saving') : t('setup.save')}
          </button>
        </div>
      </div>
      <ConfirmModal
        isOpen={pendingTemplate !== null}
        variant="warning"
        title={pendingTemplate === null ? '' : t('setup.templateConfirmTitle', { template: t(TEMPLATE_TEXT[pendingTemplate.id].nameKey) })}
        message={pendingTemplate === null ? '' : templateMessage(pendingTemplate, t, i18n.language)}
        confirmLabel={t('setup.templateApply')}
        onCancel={() => setPendingTemplate(null)}
        onConfirm={() => {
          if (pendingTemplate !== null) replace(pendingTemplate.draft)
          setPendingTemplate(null)
        }}
      />
    </ModalShell>
  )
}

/** "Your metrics become … · Archived (scores kept): … · Nothing is saved until you press Save." */
function templateMessage(change: TemplateChange, t: (key: string, options?: Record<string, unknown>) => string, language: string): string {
  const parts = [
    t('setup.templateBecomes', { metrics: joinNames(change.metrics, language) }),
    change.archived.length > 0 ? t('setup.templateArchives', { metrics: joinNames(change.archived, language) }) : '',
    t('setup.templateNotSaved'),
  ]
  return parts.filter((part) => part !== '').join(' ')
}
