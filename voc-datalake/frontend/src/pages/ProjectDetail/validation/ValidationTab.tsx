/**
 * @fileoverview Project → Validate (7.68.00, docs/project-workspace.md → Validate): the methodology's last step,
 * tenet 2's "review". The success criteria (read once from the PRD, then edited), the plan (interview guide and test
 * script, by AI or by hand), the personas' synthetic run (labelled, never "met"), the "Tell us how it went" card the
 * prototype shows real testers, the results judged against each criterion's target on real testers only, and the
 * report with its prefilled decision. Every route is an edit: viewers are told so and see nothing (its results quote
 * what testers typed).
 * @module pages/ProjectDetail/validation/ValidationTab
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ClipboardCheck, FileText, FlaskConical, Save, Scale, Sparkles } from 'lucide-react'
import MethodologyGaps from '../../../components/MethodologyGaps/MethodologyGaps'
import { projectKey } from '../../../api/projectQueryKeys'
import { validationApi, validationKeys } from '../../../api/validationApi'
import RowsEditor from './RowsEditor'
import ValidationResults from './ValidationResults'
import {
  LIMITS, cardLanguage, criteriaRows, decisionLink, rowsValid, taskRows, toCriteria, toTasks,
} from './validationModel'
import type { EditorRow } from './validationModel'
import type { ProjectDocument } from '../../../api/types'
import type { ValidationView } from '../../../api/validationApi'

interface ValidationTabProps {
  readonly projectId: string
  readonly canEdit: boolean
  readonly documents: readonly ProjectDocument[]
  /** Opens a plan, run or report on the Documents tab. */
  readonly onSelectDoc: (document: ProjectDocument) => void
}

/** Every mutation of the tab: run it, then read the view and the project (its documents) again. */
function useValidationActions(projectId: string) {
  const queryClient = useQueryClient()
  const { i18n } = useTranslation()
  const language = cardLanguage(i18n.language)
  const settle = async () => {
    await queryClient.invalidateQueries({ queryKey: validationKeys.view(projectId) })
    await queryClient.invalidateQueries({ queryKey: projectKey(projectId) })
  }
  const saveCriteria = useMutation({
    mutationFn: (args: { rows: EditorRow[]; revision: number }) =>
      validationApi.saveCriteria(projectId, toCriteria(args.rows), args.revision),
    onSettled: settle,
  })
  const extract = useMutation({
    mutationFn: (replace: boolean) => validationApi.extractCriteria(projectId, replace, language), onSettled: settle,
  })
  const plan = useMutation({
    mutationFn: (mode: 'ai' | 'blank') => validationApi.writePlan(projectId, mode, language), onSettled: settle,
  })
  const synthetic = useMutation({ mutationFn: () => validationApi.runSynthetic(projectId), onSettled: settle })
  const card = useMutation({
    mutationFn: (args: { rows: EditorRow[]; open: boolean; revision: number }) => validationApi.saveCard(projectId, {
      tasks: toTasks(args.rows), open: args.open, language, expectedRevision: args.revision,
    }),
    onSettled: settle,
  })
  const report = useMutation({ mutationFn: () => validationApi.writeReport(projectId, language), onSettled: settle })
  return { saveCriteria, extract, plan, synthetic, card, report }
}

type Actions = ReturnType<typeof useValidationActions>

function ErrorLine({ error }: Readonly<{ error: unknown }>) {
  if (!(error instanceof Error)) return null
  return <p role="alert" className="text-sm text-danger">{error.message}</p>
}

function DocumentButton({ documentId, documents, label, onSelectDoc }: Readonly<{
  documentId: string | null; documents: readonly ProjectDocument[]; label: string
  onSelectDoc: (document: ProjectDocument) => void
}>) {
  const document = documents.find((one) => one.document_id === documentId)
  if (document === undefined) return null
  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onSelectDoc(document)}>
      <FileText size={14} aria-hidden />
      {label}
    </button>
  )
}

function CriteriaSection({ view, actions }: Readonly<{ view: ValidationView; actions: Actions }>) {
  const { t } = useTranslation('projectDetail')
  const saved = view.validation
  // Remounted on every saved revision (its key), so the editor always starts from what is stored.
  const [rows, setRows] = useState<EditorRow[]>(() => criteriaRows(saved.criteria))
  const busy = actions.saveCriteria.isPending || actions.extract.isPending
  const extract = () => {
    if (saved.criteria.length > 0 && !window.confirm(t('validation.criteria.replaceConfirm'))) return
    actions.extract.mutate(saved.criteria.length > 0)
  }
  return (
    <section className="card space-y-3 p-4" aria-label={t('validation.criteria.title')}>
      <h3 className="text-sm font-semibold text-text-strong">{t('validation.criteria.title')}</h3>
      <p className="text-[12px] text-muted">{t('validation.criteria.hint')}</p>
      <RowsEditor rows={rows} onChange={setRows} max={LIMITS.criteria} disabled={busy}
        rowLabel={(n) => t('validation.criteria.text', { number: n })}
        removeLabel={(n) => t('validation.criteria.remove', { number: n })}
        addLabel={t('validation.criteria.add')} targetLabel={t('validation.criteria.target')} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !rowsValid(rows, true)}
          onClick={() => actions.saveCriteria.mutate({ rows, revision: saved.revision })}>
          <Save size={14} aria-hidden />
          {t('validation.criteria.save')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={extract}>
          <Sparkles size={14} aria-hidden />
          {actions.extract.isPending ? t('validation.criteria.reading') : t('validation.criteria.fromPrd')}
        </button>
      </div>
      <ErrorLine error={actions.saveCriteria.error ?? actions.extract.error} />
    </section>
  )
}

function PlanSection({ view, actions, documents, onSelectDoc }: Readonly<{
  view: ValidationView; actions: Actions; documents: readonly ProjectDocument[]
  onSelectDoc: (document: ProjectDocument) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const ready = view.validation.criteria.length > 0
  const busy = actions.plan.isPending
  return (
    <section className="card space-y-3 p-4" aria-label={t('validation.plan.title')}>
      <h3 className="text-sm font-semibold text-text-strong">{t('validation.plan.title')}</h3>
      <p className="text-[12px] text-muted">{t('validation.plan.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!ready || busy}
          onClick={() => actions.plan.mutate('ai')}>
          <Sparkles size={14} aria-hidden />
          {busy ? t('validation.plan.writing') : t('validation.plan.ai')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!ready || busy}
          onClick={() => actions.plan.mutate('blank')}>
          {t('validation.plan.blank')}
        </button>
        <DocumentButton documentId={view.validation.plan_document_id} documents={documents}
          label={t('validation.plan.open')} onSelectDoc={onSelectDoc} />
      </div>
      <MethodologyGaps block={view.methodology} testId="validation-methodology" />
      <ErrorLine error={actions.plan.error} />
    </section>
  )
}

function CardSection({ view, actions }: Readonly<{ view: ValidationView; actions: Actions }>) {
  const { t } = useTranslation('projectDetail')
  const saved = view.validation
  const [rows, setRows] = useState<EditorRow[]>(() => taskRows(saved.tasks))
  const [open, setOpen] = useState(saved.form_open)
  const busy = actions.card.isPending
  const form = view.form
  return (
    <section className="card space-y-3 p-4" aria-label={t('validation.card.title')}>
      <h3 className="text-sm font-semibold text-text-strong">{t('validation.card.title')}</h3>
      <p className="text-[12px] text-muted">{t('validation.card.hint')}</p>
      <RowsEditor rows={rows} onChange={setRows} max={LIMITS.tasks} disabled={busy}
        rowLabel={(n) => t('validation.card.task', { number: n })}
        removeLabel={(n) => t('validation.card.removeTask', { number: n })} addLabel={t('validation.card.addTask')} />
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={open} disabled={busy} onChange={(event) => setOpen(event.target.checked)} />
        {t('validation.card.open')}
      </label>
      {form === null ? null : (
        <p className="text-[12px] text-muted" data-testid="validation-card-state">
          {form.open ? t('validation.card.live', { revision: form.revision }) : t('validation.card.closed')}
        </p>
      )}
      {form?.stale === true ? <p className="text-sm text-warn">{t('validation.card.stale')}</p> : null}
      {form !== null && !saved.card_in_prototype ? <p className="text-sm text-warn">{t('validation.card.oldWidget')}</p> : null}
      <button type="button" className="btn btn-primary btn-sm"
        disabled={busy || saved.criteria.length === 0 || !rowsValid(rows, false)}
        onClick={() => actions.card.mutate({ rows, open, revision: saved.revision })}>
        <Save size={14} aria-hidden />
        {t('validation.card.save')}
      </button>
      <ErrorLine error={actions.card.error} />
    </section>
  )
}

function SyntheticSection({ view, actions }: Readonly<{ view: ValidationView; actions: Actions }>) {
  const { t, i18n } = useTranslation('projectDetail')
  const run = view.synthetic
  const busy = actions.synthetic.isPending
  return (
    <section className="card space-y-3 p-4" aria-label={t('validation.synthetic.title')}>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-strong">
        <FlaskConical size={16} aria-hidden />
        {t('validation.synthetic.title')}
        <span className="badge badge-aim">{t('validation.synthetic.label')}</span>
      </h3>
      <p className="text-[12px] text-muted">{t('validation.synthetic.hint')}</p>
      {run === null ? null : (
        <p className="text-sm text-text">{t('validation.synthetic.lastRun', {
          date: new Date(run.created_at ?? '').toLocaleDateString(i18n.language), personas: run.personas,
        })}</p>
      )}
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy || view.validation.tasks.length === 0}
        onClick={() => actions.synthetic.mutate()}>
        <FlaskConical size={14} aria-hidden />
        {busy ? t('validation.synthetic.running') : t('validation.synthetic.run')}
      </button>
      <ErrorLine error={actions.synthetic.error} />
    </section>
  )
}

function ReportSection({ projectId, view, actions, documents, onSelectDoc }: Readonly<{
  projectId: string; view: ValidationView; actions: Actions; documents: readonly ProjectDocument[]
  onSelectDoc: (document: ProjectDocument) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const busy = actions.report.isPending
  const prefill = view.decision_prefill
  return (
    <section className="card space-y-3 p-4" aria-label={t('validation.report.title')}>
      <h3 className="text-sm font-semibold text-text-strong">{t('validation.report.title')}</h3>
      <p className="text-[12px] text-muted">{t('validation.report.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || view.criteria.length === 0}
          onClick={() => actions.report.mutate()}>
          <ClipboardCheck size={14} aria-hidden />
          {busy ? t('validation.report.writing') : t('validation.report.write')}
        </button>
        <DocumentButton documentId={view.validation.report_document_id} documents={documents}
          label={t('validation.report.open')} onSelectDoc={onSelectDoc} />
        {prefill === null || view.validation.report_document_id === null ? null : (
          <Link to={decisionLink(projectId, prefill)} className="btn btn-secondary btn-sm">
            <Scale size={14} aria-hidden />
            {t('validation.report.decide')}
          </Link>
        )}
      </div>
      <ErrorLine error={actions.report.error} />
    </section>
  )
}

function ValidationSections({ projectId, view, documents, onSelectDoc }: Readonly<{
  projectId: string; view: ValidationView; documents: readonly ProjectDocument[]
  onSelectDoc: (document: ProjectDocument) => void
}>) {
  const actions = useValidationActions(projectId)
  return (
    <>
      <CriteriaSection key={`criteria-${view.validation.revision}`} view={view} actions={actions} />
      <PlanSection view={view} actions={actions} documents={documents} onSelectDoc={onSelectDoc} />
      <CardSection key={`card-${view.validation.revision}`} view={view} actions={actions} />
      <SyntheticSection view={view} actions={actions} />
      <ValidationResults view={view} />
      <ReportSection projectId={projectId} view={view} actions={actions} documents={documents} onSelectDoc={onSelectDoc} />
    </>
  )
}

export default function ValidationTab({ projectId, canEdit, documents, onSelectDoc }: ValidationTabProps) {
  const { t } = useTranslation('projectDetail')
  const query = useQuery({
    queryKey: validationKeys.view(projectId), queryFn: () => validationApi.get(projectId), enabled: canEdit,
  })
  const hasPrototype = documents.some((document) => document.document_type === 'prototype')
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <p className="max-w-3xl text-sm text-text">{t('validation.intro')}</p>
      {hasPrototype ? null : <p className="card p-4 text-sm text-muted">{t('validation.noPrototype')}</p>}
      {!canEdit ? <p className="card p-4 text-sm text-muted">{t('validation.readOnly')}</p> : null}
      {canEdit && query.isError ? <p role="alert" className="card p-4 text-sm text-danger">{t('validation.loadFailed')}</p> : null}
      {canEdit && query.data !== undefined
        ? <ValidationSections projectId={projectId} view={query.data} documents={documents} onSelectDoc={onSelectDoc} />
        : null}
    </div>
  )
}
