/**
 * ProductTab — capture the current product/service description that downstream
 * PRD / PR-FAQ generation will use as context.
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
import {
  MessageSquare, Upload, Send, Loader2,
  CheckCircle2, AlertCircle, Sparkles, FileOutput,
} from 'lucide-react'
import {
  useCallback, useEffect, useRef, useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { pollJobToCompletion } from './jobPolling'
import { DocsUpload } from './ProductDocsUpload'
import {
  SelectField, TextAreaField, TextField,
} from './ProductFormFields'
import type {
  ProductContext, ProductLifecycleState,
} from '../../api/types'

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

const emptyContext = (): ProductContext => ({
  product_name: '',
  one_liner: '',
  target_users: '',
  problem_solved: '',
  current_state: '',
  key_features: '',
  differentiators: '',
  known_limitations: '',
  non_goals: '',
  success_metrics: '',
  free_form_notes: '',
})

type Mode = 'both' | 'chat' | 'upload'

const modeKey = (projectId: string) => `voc:productTabMode:${projectId}`

/** Read the persisted tab mode for a project, defaulting to 'both'. */
function readSavedMode(projectId: string): Mode {
  const saved = localStorage.getItem(modeKey(projectId))
  return saved === 'chat' || saved === 'upload' || saved === 'both' ? saved : 'both'
}

interface ProductTabProps {
  readonly projectId: string
  readonly onDocumentChanged?: () => void
}

export default function ProductTab({ projectId, onDocumentChanged }: ProductTabProps) {
  const { t, i18n } = useTranslation('projectDetail')
  const [mode, setMode] = useState<Mode>(() => readSavedMode(projectId))
  const [context, setContext] = useState<ProductContext>(emptyContext)
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

  useEffect(() => {
    const lifecycle = { cancelled: false }
    projectsApi.getProductContext(projectId).then((r) => {
      if (!lifecycle.cancelled) setContext({ ...emptyContext(), ...r.context })
    }).catch((e) => {
      console.error('Failed to load product context', e)
    }).finally(() => {
      if (!lifecycle.cancelled) setLoading(false)
    })
    return () => { lifecycle.cancelled = true }
  }, [projectId])

  const persistField = useCallback(async <K extends keyof ProductContext>(
    field: K, value: ProductContext[K],
  ) => {
    setSavingField(field)
    try {
      const r = await projectsApi.updateProductContext(projectId, singleFieldPatch(field, value))
      setContext({ ...emptyContext(), ...r.context })
    } catch (e) {
      console.error(`Failed to save ${String(field)}`, e)
    } finally {
      setSavingField(null)
    }
  }, [projectId])

  const onPatchFromChat = useCallback((patch: Partial<ProductContext>, fresh: ProductContext) => {
    setContext({ ...emptyContext(), ...fresh })
    const keys = Object.keys(patch)
    if (keys.length) {
      setHighlightFields(new Set(keys))
      setTimeout(() => setHighlightFields(new Set()), 1800)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 size={20} className="animate-spin mr-2" /> {t('product.loading')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Sparkles size={18} className="text-blue-600" />
            {t('product.title')}
          </h2>
          <p className="text-sm text-gray-500">{t('product.subtitle')}</p>
        </div>
        <ModeToggle mode={mode} onChange={setModePersist} t={t} />
      </div>

      <div className={`grid gap-4 ${mode === 'both' ? 'lg:grid-cols-2' : 'grid-cols-1'}`}>
        <ProductForm
          context={context}
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
            <DocsUpload projectId={projectId} t={t} />
          )}
          <ReportCard
            projectId={projectId}
            language={i18n.language}
            onDocumentChanged={onDocumentChanged}
            t={t}
          />
        </div>
      </div>
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
    <div className="inline-flex rounded-lg border bg-white p-0.5 text-xs">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md whitespace-nowrap ${
            mode === o.id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:text-gray-900'
          }`}
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
  context, savingField, highlightFields, onPersistField, t,
}: {
  readonly context: ProductContext
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
    <div className="bg-white border rounded-xl p-4 sm:p-6 space-y-4">
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
    </div>
  )
}

// ── Interview chat ──────────────────────────────────────────────────────────

interface ChatTurn { role: 'user' | 'assistant'; content: string }

function InterviewChat({
  projectId, language, onPatch, t,
}: {
  readonly projectId: string
  readonly language: string
  readonly onPatch: (patch: Partial<ProductContext>, fresh: ProductContext) => void
  readonly t: TFunc
}) {
  const [history, setHistory] = useState<ChatTurn[]>([{
    role: 'assistant',
    content: t('product.interview.greeting'),
  }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // When the language flips after mount, refresh the greeting (only if
  // nothing else has been said). Render-phase adjustment keyed on the
  // language prop replaces the previous setState-in-effect sync on t.
  const [prevLanguage, setPrevLanguage] = useState(language)
  if (prevLanguage !== language) {
    setPrevLanguage(language)
    if (history.length === 1) {
      setHistory([{ role: 'assistant', content: t('product.interview.greeting') }])
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [history])

  const decode = useCallback((message: string) => {
    if (message === '__captured__') return t('product.interview.captured')
    if (message === '__elaborate__') return t('product.interview.elaborate')
    return message
  }, [t])

  const send = useCallback(async () => {
    const message = input.trim()
    if (!message || busy) return
    setInput('')
    setBusy(true)
    const nextHistory: ChatTurn[] = [...history, { role: 'user', content: message }]
    setHistory(nextHistory)
    try {
      const r = await projectsApi.productContextInterview(projectId, {
        message,
        history: nextHistory.slice(-12),
        response_language: language,
      })
      setHistory([...nextHistory, { role: 'assistant', content: decode(r.assistant_message) }])
      if (r.applied_patch && Object.keys(r.applied_patch).length > 0) {
        onPatch(r.applied_patch, r.context)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Interview failed'
      setHistory([...nextHistory, { role: 'assistant', content: `⚠️ ${msg}` }])
    } finally {
      setBusy(false)
    }
  }, [input, busy, history, projectId, onPatch, language, decode])

  return (
    <div className="bg-white border rounded-xl p-4 flex flex-col" style={{ height: 480 }}>
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare size={16} className="text-blue-600" />
        <h3 className="text-sm font-semibold">{t('product.interview.heading')}</h3>
        <span className="text-xs text-gray-400">— {t('product.interview.hint')}</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {history.map((m, i) => (
          <div key={i} className={`text-sm ${m.role === 'user' ? 'text-right' : ''}`}>
            <div className={`inline-block max-w-[90%] rounded-lg px-3 py-2 whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'
            }`}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="text-xs text-gray-400 inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" /> {t('product.interview.thinking')}
          </div>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          disabled={busy}
          placeholder={t('product.interview.placeholder')}
          className="flex-1 px-3 py-2 border rounded-md text-sm"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          aria-label={t('product.interview.send')}
          className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}

// ── Generate report ─────────────────────────────────────────────────────────

function ReportCard({
  projectId, language, onDocumentChanged, t,
}: {
  readonly projectId: string
  readonly language: string
  readonly onDocumentChanged?: () => void
  readonly t: TFunc
}) {
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Async: kick off the job, then poll until completed/failed. Polling beats a
  // long-running fetch because API Gateway caps requests at 29s and Bedrock can
  // take ~40s to produce a Korean report. Tolerate transient network errors so
  // a Wi-Fi blip mid-poll doesn't kill the flow.
  const onGenerate = useCallback(async () => {
    setBusy(true)
    setError(null)
    setSuccess(false)
    try {
      const start = await projectsApi.generateProductReport(projectId, { response_language: language })
      const outcome = await pollJobToCompletion(projectId, start.job_id, { intervalMs: 2500 })
      if (outcome.status === 'completed') {
        setSuccess(true)
        onDocumentChanged?.()
        return
      }
      if (outcome.status === 'failed') {
        throw new Error(outcome.job.error || 'Report generation failed')
      }
      throw new Error(t('product.report.timeout', { defaultValue: 'Report generation took too long. Check the Documents tab in a moment.' }))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Report failed'
      setError(msg.includes('at least one product context') || msg.includes('one product') || msg.toLowerCase().includes('add at least')
        ? t('product.report.errorEmpty')
        : msg)
    } finally {
      setBusy(false)
    }
  }, [projectId, language, onDocumentChanged, t])

  return (
    <div className="bg-white border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <FileOutput size={16} className="text-emerald-600" />
        <h3 className="text-sm font-semibold">{t('product.report.title')}</h3>
      </div>
      <p className="text-xs text-gray-500 mb-3">{t('product.report.description')}</p>
      <button
        onClick={onGenerate}
        disabled={busy}
        className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center justify-center gap-2 text-sm disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <FileOutput size={14} />}
        {busy ? t('product.report.generating') : t('product.report.button')}
      </button>
      {success && (
        <div className="mt-2 text-xs text-emerald-700 inline-flex items-center gap-1">
          <CheckCircle2 size={12} />
          <span><strong>{t('product.report.successTitle')}.</strong> {t('product.report.successMessage')}</span>
        </div>
      )}
      {error && (
        <div className="mt-2 text-xs text-red-600 inline-flex items-center gap-1">
          <AlertCircle size={12} /> {error}
        </div>
      )}
    </div>
  )
}
