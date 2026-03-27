/**
 * @fileoverview Scraper editor modal component.
 * @module pages/Scrapers/ScraperEditor
 */

import clsx from 'clsx'
import {
  Save, AlertCircle, CheckCircle, Loader2, Wand2, Code, FileJson, Info,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import {
  FREQUENCY_OPTIONS, DEFAULT_SCRAPER,
} from './constants'
import type {
  ScraperConfig, ScraperTemplate,
} from '../../api/types'

interface ScraperEditorProps {
  readonly scraper: ScraperConfig | null
  readonly template?: ScraperTemplate | null
  readonly onSave: (scraper: ScraperConfig) => void
  readonly onClose: () => void
}

interface AnalyzeResult {
  success: boolean
  message?: string
  confidence?: string
  warnings?: string[]
}

function buildInitialConfig(scraper: ScraperConfig | null, template: ScraperTemplate | null | undefined): ScraperConfig {
  if (scraper) return scraper

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
  scraper, template, onSave, onClose,
}: ScraperEditorProps) {
  const { t } = useTranslation('scrapers')
  const [config, setConfig] = useState<ScraperConfig>(() => buildInitialConfig(scraper, template))
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [urlInput, setUrlInput] = useState(config.urls.join('\n'))
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null)

  const handleSave = () => {
    const urls = urlInput.split('\n').map((u) => u.trim()).filter(Boolean)
    onSave({
      ...config,
      urls,
    })
  }

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-3 sm:p-4 border-b flex items-center justify-between">
          <h3 className="font-semibold text-base sm:text-lg">{scraper ? t('editor.editTitle') : t('editor.newTitle')}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
        </div>

        <div className="p-3 sm:p-4 space-y-4 overflow-y-auto flex-1">
          <BasicSettings config={config} setConfig={setConfig} />
          <UrlInput config={config} setConfig={setConfig} isAnalyzing={isAnalyzing} onAutoDetect={() => void handleAutoDetect()} />
          {analyzeResult ? <AnalyzeResultDisplay result={analyzeResult} /> : null}
          <AdditionalUrls urlInput={urlInput} setUrlInput={setUrlInput} />
          <PaginationSettings config={config} setConfig={setConfig} />
          {config.extraction_method === 'jsonld' && <JsonLdIndicator />}
          {config.extraction_method !== 'jsonld' && (
            <CssSelectorToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} />
          )}
          {showAdvanced && config.extraction_method !== 'jsonld' ? <CssSelectors config={config} setConfig={setConfig} analyzeSuccess={analyzeResult?.success} /> : null}
        </div>

        <div className="p-3 sm:p-4 border-t flex flex-col-reverse sm:flex-row justify-end gap-2">
          <button onClick={onClose} className="btn btn-secondary text-sm">{t('editor.cancel')}</button>
          <button onClick={handleSave} className="btn btn-primary flex items-center justify-center gap-2 text-sm">
            <Save size={16} /> {t('editor.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

function BasicSettings({
  config, setConfig,
}: {
  readonly config: ScraperConfig;
  readonly setConfig: (c: ScraperConfig) => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
      <div>
        <label className="block text-sm font-medium mb-1">{t('editor.scraperName')}</label>
        <input type="text" value={config.name} onChange={(e) => setConfig({
          ...config,
          name: e.target.value,
        })} className="input" placeholder={t('editor.scraperNamePlaceholder')} />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">{t('editor.frequency')}</label>
        <select value={config.frequency_minutes} onChange={(e) => setConfig({
          ...config,
          frequency_minutes: Number.parseInt(e.target.value),
        })} className="input">
          {FREQUENCY_OPTIONS.map((opt) => <option key={opt.value.toString()} value={opt.value}>{opt.label}</option>)}
        </select>
      </div>
    </div>
  )
}

function UrlInput({
  config, setConfig, isAnalyzing, onAutoDetect,
}: {
  readonly config: ScraperConfig
  readonly setConfig: (c: ScraperConfig) => void
  readonly isAnalyzing: boolean
  readonly onAutoDetect: () => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{t('editor.websiteUrl')}</label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input type="url" value={config.base_url} onChange={(e) => setConfig({
          ...config,
          base_url: e.target.value,
        })} className="input flex-1" placeholder={t('editor.websiteUrlPlaceholder')} />
        <button onClick={onAutoDetect} disabled={isAnalyzing || config.base_url === ''} className="btn btn-secondary flex items-center justify-center gap-2 whitespace-nowrap text-sm">
          {isAnalyzing ? <><Loader2 size={16} className="animate-spin" /> {t('editor.analyzing')}</> : <><Wand2 size={16} /> {t('editor.autoDetect')}</>}
        </button>
      </div>
      <p className="text-xs text-gray-500 mt-1">{t('editor.autoDetectHint')}</p>
    </div>
  )
}

function AnalyzeResultDisplay({ result }: { readonly result: AnalyzeResult }) {
  const { t } = useTranslation('scrapers')
  return (
    <div className={clsx('p-3 rounded-lg text-sm flex items-start gap-2', result.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800')}>
      {result.success ? <CheckCircle size={18} className="shrink-0 mt-0.5" /> : <AlertCircle size={18} className="shrink-0 mt-0.5" />}
      <div>
        <p>{result.message}</p>
        {result.confidence != null && result.confidence !== '' ? <p className="text-xs mt-1 opacity-75">{t('editor.confidence', { level: result.confidence })}</p> : null}
        {result.warnings && result.warnings.length > 0 ? <div className="mt-2 text-xs text-amber-700 bg-amber-50 p-2 rounded">
          <p className="font-medium mb-1">⚠️ {t('editor.warnings')}</p>
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
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label className="block text-sm font-medium">{t('editor.additionalUrls')}</label>
        <div className="group relative">
          <Info size={14} className="text-gray-400 cursor-help" />
          <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 p-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg z-10">
            {t('editor.additionalUrlsHint')}
          </div>
        </div>
      </div>
      <textarea value={urlInput} onChange={(e) => setUrlInput(e.target.value)} className="input min-h-[80px] font-mono text-sm" placeholder={t('editor.additionalUrlsPlaceholder')} />
      <p className="text-xs text-gray-500 mt-1">{t('editor.additionalUrlsNote')}</p>
    </div>
  )
}

function PaginationSettings({
  config, setConfig,
}: {
  readonly config: ScraperConfig;
  readonly setConfig: (c: ScraperConfig) => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="border rounded-lg p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={config.pagination.enabled} onChange={(e) => setConfig({
            ...config,
            pagination: {
              ...config.pagination,
              enabled: e.target.checked,
            },
          })} className="rounded" />
          <span className="font-medium text-sm">{t('editor.enablePagination')}</span>
        </label>
        <div className="group relative">
          <Info size={14} className="text-gray-400 cursor-help" />
          <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 sm:w-72 p-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg z-10">
            {t('editor.paginationHint')}
          </div>
        </div>
      </div>
      {config.pagination.enabled ? <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.pageParam')}</label>
          <input type="text" value={config.pagination.param} onChange={(e) => setConfig({
            ...config,
            pagination: {
              ...config.pagination,
              param: e.target.value,
            },
          })} className="input text-sm" placeholder={t('editor.pageParamPlaceholder')} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.start')}</label>
          <input type="number" value={config.pagination.start} onChange={(e) => setConfig({
            ...config,
            pagination: {
              ...config.pagination,
              start: Number.isNaN(Number.parseInt(e.target.value)) ? 1 : Number.parseInt(e.target.value),
            },
          })} className="input text-sm" min={0} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.maxPages')}</label>
          <input type="number" value={config.pagination.max_pages} onChange={(e) => setConfig({
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
    <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-sm">
      <div className="flex items-center gap-2 text-green-800 font-medium mb-1">
        <FileJson size={16} /> {t('editor.jsonLdTitle')}
      </div>
      <p className="text-green-700">{t('editor.jsonLdDescription')}</p>
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
    <button onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-2 text-sm font-medium text-blue-600">
      <Code size={16} /> {showAdvanced ? t('editor.hideCssSelectors') : t('editor.showCssSelectors')}
    </button>
  )
}

function CssSelectors({
  config, setConfig, analyzeSuccess,
}: {
  readonly config: ScraperConfig;
  readonly setConfig: (c: ScraperConfig) => void;
  readonly analyzeSuccess?: boolean
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="border rounded-lg p-3 sm:p-4 space-y-3 bg-gray-50">
      <p className="text-sm text-gray-600 mb-3">{analyzeSuccess === true ? t('editor.selectorsAutoDetected') : t('editor.selectorsDefault')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.reviewContainer')}</label>
          <input type="text" value={config.container_selector} onChange={(e) => setConfig({
            ...config,
            container_selector: e.target.value,
          })} className="input text-sm font-mono" placeholder=".review" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.textContent')}</label>
          <input type="text" value={config.text_selector} onChange={(e) => setConfig({
            ...config,
            text_selector: e.target.value,
          })} className="input text-sm font-mono" placeholder=".review-text" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.selectorTitle')}</label>
          <input type="text" value={config.title_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            title_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder=".review-title" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.rating')}</label>
          <input type="text" value={config.rating_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            rating_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder=".stars" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.date')}</label>
          <input type="text" value={config.date_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            date_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder="time" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">{t('editor.author')}</label>
          <input type="text" value={config.author_selector ?? ''} onChange={(e) => setConfig({
            ...config,
            author_selector: e.target.value === '' ? undefined : e.target.value,
          })} className="input text-sm font-mono" placeholder=".author" />
        </div>
      </div>
    </div>
  )
}
