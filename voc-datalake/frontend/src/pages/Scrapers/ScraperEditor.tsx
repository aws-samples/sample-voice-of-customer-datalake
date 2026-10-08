/**
 * @fileoverview Scraper editor modal component.
 * @module pages/Scrapers/ScraperEditor
 */

import clsx from 'clsx'
import { Save, AlertCircle, AlertTriangle, CheckCircle, Loader2, Wand2, Code, FileJson, Globe, Info } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import {
  FREQUENCY_OPTIONS, DEFAULT_SCRAPER,
} from './constants'
import type {
  ScraperConfig, ScraperTemplate,
} from '../../api/types'
import ModalShell from '../../components/ModalShell/ModalShell'
import { saveIgnoringFailure, useSnapshotGuard } from '../../components/UnsavedChangesGuard/useSnapshotGuard'
import SourceDialogHeader from './SourceDialogHeader'
import DimensionDefaultsSection from '../../components/DimensionFields/DimensionDefaultsSection'

interface ScraperEditorProps {
  readonly scraper: ScraperConfig | null
  readonly template?: ScraperTemplate | null
  /**
   * Whether the current user is an admin. Save (`POST /scrapers`) is open to
   * every authenticated user — owner decision (2026-10-04): any user may create
   * or edit a scraper. The ONE admin-only field is the schedule: the server keeps
   * a non-admin's `frequency_minutes` / `enabled` at the stored value (or the
   * default for a new scraper), so the frequency control is disabled for them
   * rather than offering a choice the save would discard.
   */
  readonly isAdmin: boolean
  /** The host's save; resolves once saved (and closed), rejects on failure. */
  readonly onSave: (scraper: ScraperConfig) => Promise<unknown>
  readonly onClose: () => void
  /** Why the last save was rejected (shown as an alert; the editor stays open), or null. */
  readonly saveError?: string | null
  /** A save is in flight: Save is disabled so it cannot be sent twice. */
  readonly isSaving?: boolean
}

interface AnalyzeResult {
  success: boolean
  message?: string
  confidence?: string
  warnings?: string[]
}

/** Props shared by the editor's form sections: the draft config and its setter. */
interface SectionProps {
  readonly config: ScraperConfig
  readonly setConfig: (c: ScraperConfig) => void
}

function buildInitialConfig(scraper: ScraperConfig | null, template: ScraperTemplate | null | undefined): ScraperConfig {
  // Merge over DEFAULT_SCRAPER so a stored config missing fields (e.g. urls or
  // pagination from an API-created or partially-saved record) can't crash the editor.
  if (scraper) return { ...DEFAULT_SCRAPER, ...scraper }

  const base: ScraperConfig = {
    ...DEFAULT_SCRAPER,
    id: `scraper_${Date.now()}`,
  }

  if (template) {
    const parenIndex = template.name.indexOf('(')
    const cleanName = parenIndex > 0 ? template.name.slice(0, parenIndex).trim() : template.name
    return {
      ...base,
      name: cleanName,
      extraction_method: template.extraction_method,
      template: template.id,
      base_url: template.url_placeholder,
      pagination: template.pagination,
      ...template.config,
    }
  }

  return base
}

export default function ScraperEditor({
  scraper, template, isAdmin, onSave, onClose, saveError = null, isSaving = false,
}: ScraperEditorProps) {
  const { t } = useTranslation('scrapers')
  const titleId = useId()
  const [config, setConfig] = useState<ScraperConfig>(() => buildInitialConfig(scraper, template))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [urlInput, setUrlInput] = useState(config.urls.join('\n'))
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null)

  const submit = () => onSave({ ...config, urls: urlInput.split('\n').map((u) => u.trim()).filter(Boolean) })
  // A rejected save keeps the draft open; the host shows why (`saveError`).
  const handleSave = () => saveIgnoringFailure(submit)
  // Cancel and the X ask first when the configuration has edits (E2E F6).
  const { close, dialog: guardDialog } = useSnapshotGuard({ value: { config, urlInput }, onSave: submit, onClose })

  const handleAutoDetect = async () => {
    if (config.base_url === '') {
      setAnalyzeResult({
        success: false,
        message: t('editor.enterUrlFirst'),
      })
      return
    }

    setIsAnalyzing(true)
    setAnalyzeResult(null)

    try {
      const result = await scrapersApi.analyzeUrlForSelectors(config.base_url)

      if (result.success && result.selectors) {
        applyDetectedSelectors(result.selectors)
      } else {
        setAnalyzeResult({
          success: false,
          message: result.error ?? t('editor.couldNotDetect'),
        })
      }
    } catch {
      setAnalyzeResult({
        success: false,
        message: t('editor.failedToAnalyze'),
      })
    } finally {
      setIsAnalyzing(false)
    }
  }

  const applyDetectedSelectors = (selectors: NonNullable<Awaited<ReturnType<typeof scrapersApi.analyzeUrlForSelectors>>['selectors']>) => {
    const baseRating = selectors.rating_selector ?? ''
    const ratingSelector = (selectors.rating_attribute != null && selectors.rating_attribute !== '' && baseRating !== '')
      ? `${baseRating}@${selectors.rating_attribute}`
      : baseRating

    setConfig((prev) => ({
      ...prev,
      container_selector: selectors.container_selector,
      text_selector: selectors.text_selector,
      title_selector: selectors.title_selector ?? '',
      rating_selector: ratingSelector,
      date_selector: selectors.date_selector ?? '',
      author_selector: selectors.author_selector ?? '',
    }))
    setShowAdvanced(true)
    setAnalyzeResult({
      success: true,
      message: t('editor.foundReviews', {
        count: selectors.detected_reviews_count,
        notes: selectors.notes ?? '',
      }),
      confidence: selectors.confidence,
      warnings: selectors.warnings,
    })
  }

  return (
    // Not dismissable by Escape / backdrop: a stray click would discard a whole
    // selector configuration. Cancel and the X are the explicit ways out.
    <ModalShell isOpen onClose={close} ariaLabelledBy={titleId} dismissable={false} panelClassName="max-w-2xl max-h-[95vh] sm:max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={scraper ? t('editor.editTitle') : t('editor.newTitle')} icon={Globe} tone="ok" onClose={close} />

        <div className="dialog-body space-y-4">
          <BasicSettings config={config} setConfig={setConfig} isAdmin={isAdmin} />
          <UrlInput config={config} setConfig={setConfig} isAnalyzing={isAnalyzing} onAutoDetect={() => void handleAutoDetect()} />
          {analyzeResult ? <AnalyzeResultDisplay result={analyzeResult} /> : null}
          <AdditionalUrls urlInput={urlInput} setUrlInput={setUrlInput} />
          <PaginationSettings config={config} setConfig={setConfig} />
          {config.extraction_method === 'jsonld' && <JsonLdIndicator />}
          {config.extraction_method !== 'jsonld' && (
            <CssSelectorToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} />
          )}
          {showAdvanced && config.extraction_method !== 'jsonld' ? <CssSelectors config={config} setConfig={setConfig} analyzeSuccess={analyzeResult?.success} /> : null}
          <DimensionDefaultsSection
            dimensionDefaults={config.dimension_defaults}
            tags={config.tags}
            onChange={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
          />
        </div>

        {saveError == null ? null : (
          <div role="alert" className="mx-4 mb-2 p-3 rounded-lg text-sm flex items-start gap-2 bg-danger-subtle text-danger">
            <AlertCircle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
            <p>{saveError}</p>
          </div>
        )}
        <div className="dialog-footer flex-col-reverse sm:flex-row">
          <button onClick={close} className="btn btn-secondary">{t('editor.cancel')}</button>
          <button onClick={handleSave} className="btn btn-primary" disabled={isSaving}>
            {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {t('editor.save')}
          </button>
        </div>
        {guardDialog}
    </ModalShell>
  )
}

function BasicSettings({ config, setConfig, isAdmin }: SectionProps & { readonly isAdmin: boolean }) {
  const { t } = useTranslation('scrapers')
  const id = useId()
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
      <div>
        <label htmlFor={`${id}-0`} className="block text-sm font-medium mb-1">{t('editor.scraperName')}</label>
        <input id={`${id}-0`} type="text" value={config.name} onChange={(e) => setConfig({
          ...config,
          name: e.target.value,
        })} className="input" placeholder={t('editor.scraperNamePlaceholder')} />
      </div>
      <div>
        <label htmlFor={`${id}-1`} className="block text-sm font-medium mb-1">{t('editor.frequency')}</label>
        {/* The schedule decides when the ingestor fetches (and Bedrock enriches),
            so it is admin-only like Run; the server ignores a non-admin's value. */}
        <select id={`${id}-1`} value={config.frequency_minutes} disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} onChange={(e) => setConfig({
          ...config,
          frequency_minutes: Number.parseInt(e.target.value),
        })} className="select disabled:opacity-50 disabled:cursor-not-allowed">
          {FREQUENCY_OPTIONS.map((opt) => <option key={opt.value.toString()} value={opt.value}>{opt.label}</option>)}
        </select>
      </div>
    </div>
  )
}

function UrlInput({
  config, setConfig, isAnalyzing, onAutoDetect,
}: SectionProps & {
  readonly isAnalyzing: boolean
  readonly onAutoDetect: () => void
}) {
  const { t } = useTranslation('scrapers')
  const id = useId()
  // Auto-detect exists to discover CSS selectors, so it renders only for
  // the CSS extraction method — JSON-LD scrapers get their extraction
  // config from the structured data itself, and any future method defaults
  // to hidden rather than shown. Legacy configs without the field predate
  // JSON-LD support and are CSS scrapers.
  const showAutoDetect = (config.extraction_method ?? 'css') === 'css'
  return (
    <div>
      <label htmlFor={`${id}-0`} className="block text-sm font-medium mb-1">{t('editor.websiteUrl')}</label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input id={`${id}-0`} type="url" value={config.base_url} onChange={(e) => setConfig({
          ...config,
          base_url: e.target.value,
        })} className="input flex-1" placeholder={t('editor.websiteUrlPlaceholder')} />
        {showAutoDetect && (
          <button onClick={onAutoDetect} disabled={isAnalyzing || config.base_url === ''} className="btn btn-secondary whitespace-nowrap">
            {isAnalyzing ? <><Loader2 size={16} className="animate-spin" /> {t('editor.analyzing')}</> : <><Wand2 size={16} /> {t('editor.autoDetect')}</>}
          </button>
        )}
      </div>
      {showAutoDetect && <p className="text-xs text-muted mt-1">{t('editor.autoDetectHint')}</p>}
    </div>
  )
}

function AnalyzeResultDisplay({ result }: { readonly result: AnalyzeResult }) {
  const { t } = useTranslation('scrapers')
  return (
    <div className={clsx('p-3 rounded-lg text-sm flex items-start gap-2', result.success ? 'bg-ok-subtle text-ok' : 'bg-danger-subtle text-danger')}>
      {result.success ? <CheckCircle size={18} className="shrink-0 mt-0.5" /> : <AlertCircle size={18} className="shrink-0 mt-0.5" />}
      <div>
        <p>{result.message}</p>
        {result.confidence != null && result.confidence !== '' ? <p className="text-xs mt-1">{t('editor.confidence', { level: result.confidence })}</p> : null}
        {result.warnings && result.warnings.length > 0 ? <div className="mt-2 text-xs text-warn bg-warn-subtle p-2 rounded-sm">
          <p className="font-medium mb-1 flex items-center gap-1"><AlertTriangle size={12} aria-hidden="true" /> {t('editor.warnings')}</p>
          <ul className="list-disc list-inside space-y-0.5">
            {result.warnings.map((w) => <li key={w.slice(0, 60)}>{w}</li>)}
          </ul>
        </div> : null}
      </div>
    </div>
  )
}

function AdditionalUrls({
  urlInput, setUrlInput,
}: {
  readonly urlInput: string;
  readonly setUrlInput: (v: string) => void
}) {
  const { t } = useTranslation('scrapers')
  const id = useId()
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label htmlFor={`${id}-0`} className="block text-sm font-medium">{t('editor.additionalUrls')}</label>
<HintTip text={t('editor.additionalUrlsHint')} />
      </div>
      <textarea id={`${id}-0`} value={urlInput} onChange={(e) => setUrlInput(e.target.value)} className="input min-h-[80px] font-mono text-sm" placeholder={t('editor.additionalUrlsPlaceholder')} />
      <p className="text-xs text-muted mt-1">{t('editor.additionalUrlsNote')}</p>
    </div>
  )
}

function PaginationSettings({ config, setConfig }: SectionProps) {
  const { t } = useTranslation('scrapers')
  const id = useId()
  return (
    <div className="border border-border rounded-lg p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={config.pagination.enabled} onChange={(e) => setConfig({
            ...config,
            pagination: {
              ...config.pagination,
              enabled: e.target.checked,
            },
          })} className="rounded-sm accent-accent" />
          <span className="font-medium text-sm">{t('editor.enablePagination')}</span>
        </label>
<HintTip text={t('editor.paginationHint')} />
      </div>
      {config.pagination.enabled ? <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div>
          <label htmlFor={`${id}-0`} className="block text-xs text-muted mb-1">{t('editor.pageParam')}</label>
          <input id={`${id}-0`} type="text" value={config.pagination.param} onChange={(e) => setConfig({
            ...config,
            pagination: {
              ...config.pagination,
              param: e.target.value,
            },
          })} className="input text-sm" placeholder={t('editor.pageParamPlaceholder')} />
        </div>
        <div>
          <label htmlFor={`${id}-1`} className="block text-xs text-muted mb-1">{t('editor.start')}</label>
          <input id={`${id}-1`} type="number" value={config.pagination.start} onChange={(e) => setConfig({
            ...config,
            pagination: {
              ...config.pagination,
              start: Number.isNaN(Number.parseInt(e.target.value)) ? 1 : Number.parseInt(e.target.value),
            },
          })} className="input text-sm" min={0} />
        </div>
        <div>
          <label htmlFor={`${id}-2`} className="block text-xs text-muted mb-1">{t('editor.maxPages')}</label>
          <input id={`${id}-2`} type="number" value={config.pagination.max_pages} onChange={(e) => setConfig({
            ...config,
            pagination: {
              ...config.pagination,
              max_pages: Number.isNaN(Number.parseInt(e.target.value)) ? 5 : Number.parseInt(e.target.value),
            },
          })} className="input text-sm" min={1} max={50} />
        </div>
      </div> : null}
    </div>
  )
}

function JsonLdIndicator() {
  const { t } = useTranslation('scrapers')
  return (
    <div className="p-3 rounded-lg bg-ok-subtle border border-ok/30 text-sm">
      <div className="flex items-center gap-2 text-ok font-medium mb-1">
        <FileJson size={16} /> {t('editor.jsonLdTitle')}
      </div>
      <p className="text-text">{t('editor.jsonLdDescription')}</p>
    </div>
  )
}

function CssSelectorToggle({
  showAdvanced, setShowAdvanced,
}: {
  readonly showAdvanced: boolean;
  readonly setShowAdvanced: (v: boolean) => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced} className="btn btn-ghost btn-sm -ml-2.5 text-accent-text">
      <Code size={16} /> {showAdvanced ? t('editor.hideCssSelectors') : t('editor.showCssSelectors')}
    </button>
  )
}

function CssSelectors({
  config, setConfig, analyzeSuccess,
}: SectionProps & {
  readonly analyzeSuccess?: boolean
}) {
  const { t } = useTranslation('scrapers')
  const id = useId()
  return (
    <div className="border border-border rounded-lg p-3 sm:p-4 space-y-3 bg-bg-accent">
      <p className="text-sm text-text mb-3">{analyzeSuccess === true ? t('editor.selectorsAutoDetected') : t('editor.selectorsDefault')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${id}-0`} className="block text-xs text-muted mb-1">{t('editor.reviewContainer')}</label>
          <input id={`${id}-0`} type="text" value={config.container_selector} onChange={(e) => setConfig({
            ...config,
            container_selector: e.target.value,
          })} className="input text-sm font-mono" placeholder=".review" />
        </div>
        <div>
          <label htmlFor={`${id}-1`} className="block text-xs text-muted mb-1">{t('editor.textContent')}</label>
          <input id={`${id}-1`} type="text" value={config.text_selector} onChange={(e) => setConfig({
            ...config,
            text_selector: e.target.value,
          })} className="input text-sm font-mono" placeholder=".review-text" />
        </div>
        <div>
          <label htmlFor={`${id}-2`} className="block text-xs text-muted mb-1">{t('editor.selectorTitle')}</label>
          <input id={`${id}-2`} type="text" value={config.title_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            title_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder=".review-title" />
        </div>
        <div>
          <label htmlFor={`${id}-3`} className="block text-xs text-muted mb-1">{t('editor.rating')}</label>
          <input id={`${id}-3`} type="text" value={config.rating_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            rating_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder=".stars" />
        </div>
        <div>
          <label htmlFor={`${id}-4`} className="block text-xs text-muted mb-1">{t('editor.date')}</label>
          <input id={`${id}-4`} type="text" value={config.date_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            date_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder="time" />
        </div>
        <div>
          <label htmlFor={`${id}-5`} className="block text-xs text-muted mb-1">{t('editor.author')}</label>
          <input id={`${id}-5`} type="text" value={config.author_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            author_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder=".author" />
        </div>
      </div>
    </div>
  )
}

/**
 * Info tip that opens on hover AND keyboard focus. It was a hover-only icon, so
 * the hint was unreachable without a mouse and on touch screens.
 */
function HintTip({ text }: { readonly text: string }) {
  return (
    <span className="group relative inline-flex">
      <button type="button" className="icon-btn p-0.5 cursor-help" aria-label={text} title={text}>
        <Info size={14} />
      </button>
      <span role="tooltip" className="menu absolute left-0 bottom-full mb-2 hidden group-hover:block group-focus-within:block w-64 sm:w-72 p-2 text-xs text-muted z-10">
        {text}
      </span>
    </span>
  )
}
