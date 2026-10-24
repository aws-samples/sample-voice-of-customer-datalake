/**
 * ProductTab — capture the current product/service description that downstream
 * PRD / PR/FAQ generation will use as context.
 *
 * Three operating modes (segmented control, persisted in localStorage per-project):
 *   - chat:   AI interview only
 *   - upload: internal-doc upload only
 *   - both:   side-by-side
 *
 * After inputs are filled, "Generate report" calls a backend endpoint that
 * synthesizes everything into a saved ProjectDocument (visible in Documents tab).
 *
 * All user-facing strings come from the projectDetail i18n namespace, and every
 * Bedrock-backed call passes response_language: i18n.language so output matches
 * the language picked in Settings.
 */

import { MessageSquare, Upload, Loader2, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { loadWhileMounted } from './loadWhileMounted'
import { DocsUpload } from './ProductDocsUpload'
import ProductReportCard from './ProductReportCard'
import { countFilledProductContextFields, emptyProductContext } from './productContextFields'
import { SelectField, TextAreaField, TextField } from './ProductFormFields'
import type { ProductContext, ProductLifecycleState } from '../../api/projectTypes'
import { InterviewChat } from './ProductInterviewChat'

const LIFECYCLE_STATES: readonly ProductLifecycleState[] = ['', 'idea', 'mvp', 'beta', 'ga', 'mature']

function isLifecycleState(value: string): value is ProductLifecycleState {
  return LIFECYCLE_STATES.some((state) => state === value)
}

/** Build a single-field patch without a type assertion (computed generic keys widen otherwise). */
function singleFieldPatch<K extends keyof ProductContext>(field: K, value: ProductContext[K]): Partial<ProductContext> {
  const patch: Partial<ProductContext> = {}
  patch[field] = value
  return patch
}

type Mode = 'both' | 'chat' | 'upload'

const modeKey = (projectId: string) => `voc:productTabMode:${projectId}`

/** Read the persisted tab mode for a project, defaulting to 'both'. */
function readSavedMode(projectId: string): Mode {
  const saved = localStorage.getItem(modeKey(projectId))
  return saved === 'chat' || saved === 'upload' || saved === 'both' ? saved : 'both'
}

interface ProductTabProps {
  readonly projectId: string
  /**
   * False for a viewer (`can_edit: false`): the form is shown disabled, the uploaded
   * docs are listed without upload/delete, and the interview and report — both of
   * which write — are not offered. Every one of those would otherwise 403.
   */
  readonly canEdit: boolean
  /**
   * The context was just saved, with the server's copy of it.
   *
   * This tab owns the record while it is being edited — per-field autosave against
   * local state — but the Overview card reports how complete the description is
   * from its own query. Without this, filling fields here and returning to
   * Overview left card 1 reporting the old count for the rest of the session,
   * because `ProjectDetail` stays mounted across tab switches.
   *
   * Handing the fresh context back rather than asking for a refetch: the response
   * is already in hand, so a round trip would only re-fetch what we just read.
   */
  readonly onContextSaved?: (context: ProductContext) => void
  /**
   * A report generation was started. The Background Jobs panel owns the wait;
   * the document itself lands in the Documents tab when the job completes.
   */
  readonly onJobStarted?: () => void
}

export default function ProductTab({ projectId, canEdit, onContextSaved, onJobStarted }: ProductTabProps) {
  const { t, i18n } = useTranslation('projectDetail')
  const [mode, setMode] = useState<Mode>(() => readSavedMode(projectId))
  const [context, setContext] = useState<ProductContext>(emptyProductContext)
  const [loading, setLoading] = useState(true)
  const [savingField, setSavingField] = useState<string | null>(null)
  const [highlightFields, setHighlightFields] = useState<Set<string>>(new Set())

  // When the project changes in place, re-read its persisted mode and show
  // the loader until the effect below fetches the new context. Render-phase
  // adjustment replaces the previous setState-in-effect syncs.
  const [prevProjectId, setPrevProjectId] = useState(projectId)
  if (prevProjectId !== projectId) {
    setPrevProjectId(projectId)
    setMode(readSavedMode(projectId))
    setLoading(true)
  }

  const setModePersist = useCallback((m: Mode) => {
    setMode(m)
    localStorage.setItem(modeKey(projectId), m)
  }, [projectId])

  useEffect(() => loadWhileMounted(projectsApi.getProductContext(projectId), {
    onLoaded: (r) => setContext({ ...emptyProductContext(), ...r.context }),
    errorMessage: 'Failed to load product context',
    onSettled: () => setLoading(false),
  }), [projectId])

  /**
   * Adopt a saved context: normalise it, then tell the page it changed.
   *
   * Both write paths go through here so neither can update the form while leaving
   * the Overview card reporting a stale count — and a third write path added later
   * inherits the notification instead of having to remember it.
   */
  const adoptSavedContext = useCallback((fresh: ProductContext) => {
    const normalised = {
      ...emptyProductContext(),
      ...fresh,
    }
    setContext(normalised)
    onContextSaved?.(normalised)
  }, [onContextSaved])

  const persistField = useCallback(async <K extends keyof ProductContext>(
    field: K, value: ProductContext[K],
  ) => {
    setSavingField(field)
    try {
      const r = await projectsApi.updateProductContext(projectId, singleFieldPatch(field, value))
      adoptSavedContext(r.context)
    } catch (e) {
      console.error(`Failed to save ${String(field)}`, e)
    } finally {
      setSavingField(null)
    }
  }, [projectId, adoptSavedContext])

  const onPatchFromChat = useCallback((patch: Partial<ProductContext>, fresh: ProductContext) => {
    adoptSavedContext(fresh)
    const keys = Object.keys(patch)
    if (keys.length) {
      setHighlightFields(new Set(keys))
      setTimeout(() => setHighlightFields(new Set()), 1800)
    }
  }, [adoptSavedContext])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted">
        <Loader2 size={20} className="animate-spin mr-2" /> {t('product.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles size={18} className="text-accent" />
            {t('product.title')}
          </h2>
          <p className="text-sm text-muted">{t('product.subtitle')}</p>
        </div>
        {canEdit ? <ModeToggle mode={mode} onChange={setModePersist} t={t} /> : null}
      </div>

      {canEdit ? (
        <div className={`grid gap-4 ${mode === 'both' ? 'lg:grid-cols-2' : 'grid-cols-1'}`}>
          <ProductForm
            context={context}
            readOnly={false}
            savingField={savingField}
            highlightFields={highlightFields}
            onPersistField={persistField}
            t={t}
          />

          <div className="space-y-4">
            {(mode === 'chat' || mode === 'both') && (
              <InterviewChat
                projectId={projectId}
                language={i18n.language}
                onPatch={onPatchFromChat}
                t={t}
              />
            )}
            {(mode === 'upload' || mode === 'both') && (
              <DocsUpload projectId={projectId} canEdit />
            )}
            <ProductReportCard
              projectId={projectId}
              hasNoFields={countFilledProductContextFields(context) === 0}
              onJobStarted={onJobStarted}
            />
          </div>
        </div>
      ) : (
        // A viewer reads the description and the uploaded docs; the mode toggle is
        // moot because the two write-only panes it switches between are not shown.
        <div className="grid gap-4 lg:grid-cols-2">
          <ProductForm
            context={context}
            readOnly
            savingField={savingField}
            highlightFields={highlightFields}
            onPersistField={persistField}
            t={t}
          />
          <DocsUpload projectId={projectId} canEdit={false} />
        </div>
      )}
    </div>
  )
}

// ── Mode toggle ─────────────────────────────────────────────────────────────

type TFunc = (key: string, opts?: Record<string, unknown>) => string

function ModeToggle({ mode, onChange, t }: { readonly mode: Mode; readonly onChange: (m: Mode) => void; readonly t: TFunc }) {
  const opts: { id: Mode; labelKey: string; icon: typeof MessageSquare }[] = [
    { id: 'both', labelKey: 'product.modeBoth', icon: Sparkles },
    { id: 'chat', labelKey: 'product.modeChat', icon: MessageSquare },
    { id: 'upload', labelKey: 'product.modeUpload', icon: Upload },
  ]
  return (
    <div className="tabs-track">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={clsx('tab', mode === o.id && 'tab-active')}
        >
          <o.icon size={14} />
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  )
}

// ── Form ────────────────────────────────────────────────────────────────────

function ProductForm({
  context, readOnly, savingField, highlightFields, onPersistField, t,
}: {
  readonly context: ProductContext
  /** Disables every field at once (a native `<fieldset disabled>`), so no field can save. */
  readonly readOnly: boolean
  readonly savingField: string | null
  readonly highlightFields: Set<string>
  readonly onPersistField: <K extends keyof ProductContext>(field: K, value: ProductContext[K]) => void
  readonly t: TFunc
}) {
  const lifecycleOptions: { value: ProductLifecycleState; labelKey: string }[] = [
    { value: '', labelKey: 'product.lifecycle.select' },
    { value: 'idea', labelKey: 'product.lifecycle.idea' },
    { value: 'mvp', labelKey: 'product.lifecycle.mvp' },
    { value: 'beta', labelKey: 'product.lifecycle.beta' },
    { value: 'ga', labelKey: 'product.lifecycle.ga' },
    { value: 'mature', labelKey: 'product.lifecycle.mature' },
  ]

  return (
    <fieldset disabled={readOnly} className="bg-card border rounded-xl p-4 sm:p-6 space-y-4 min-w-0">
      <TextField
        label={t('product.fields.productName')} field="product_name" value={context.product_name}
        max={200} savingField={savingField} highlight={highlightFields.has('product_name')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('product_name', v)}
      />
      <TextField
        label={t('product.fields.oneLiner')} field="one_liner" value={context.one_liner}
        max={200} savingField={savingField} highlight={highlightFields.has('one_liner')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('one_liner', v)}
      />
      <SelectField
        label={t('product.fields.currentState')} field="current_state" value={context.current_state}
        options={lifecycleOptions.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        savingField={savingField} highlight={highlightFields.has('current_state')}
        onSave={(v) => { if (isLifecycleState(v)) onPersistField('current_state', v) }}
      />
      <TextAreaField
        label={t('product.fields.targetUsers')} field="target_users" value={context.target_users}
        max={1000} rows={2} savingField={savingField}
        highlight={highlightFields.has('target_users')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('target_users', v)}
      />
      <TextAreaField
        label={t('product.fields.problemSolved')} field="problem_solved" value={context.problem_solved}
        max={2000} rows={3} savingField={savingField}
        highlight={highlightFields.has('problem_solved')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('problem_solved', v)}
      />
      <TextAreaField
        label={t('product.fields.keyFeatures')} field="key_features" value={context.key_features}
        max={2000} rows={3} savingField={savingField}
        highlight={highlightFields.has('key_features')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('key_features', v)}
      />
      <TextAreaField
        label={t('product.fields.differentiators')} field="differentiators" value={context.differentiators}
        max={2000} rows={3} savingField={savingField}
        highlight={highlightFields.has('differentiators')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('differentiators', v)}
      />
      <TextAreaField
        label={t('product.fields.knownLimitations')} field="known_limitations" value={context.known_limitations}
        max={2000} rows={3} savingField={savingField}
        highlight={highlightFields.has('known_limitations')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('known_limitations', v)}
      />
      <TextAreaField
        label={t('product.fields.nonGoals')} field="non_goals" value={context.non_goals}
        max={2000} rows={3} savingField={savingField}
        highlight={highlightFields.has('non_goals')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('non_goals', v)}
      />
      <TextAreaField
        label={t('product.fields.successMetrics')} field="success_metrics" value={context.success_metrics}
        max={2000} rows={3} savingField={savingField}
        highlight={highlightFields.has('success_metrics')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('success_metrics', v)}
      />
      <TextAreaField
        label={t('product.fields.freeFormNotes')} field="free_form_notes" value={context.free_form_notes}
        max={4000} rows={4} savingField={savingField}
        highlight={highlightFields.has('free_form_notes')}
        placeholder={t('product.fields.placeholderEmpty')}
        onSave={(v) => onPersistField('free_form_notes', v)}
      />
    </fieldset>
  )
}
