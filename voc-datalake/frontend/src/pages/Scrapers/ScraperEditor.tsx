/**
 * @fileoverview Scraper editor modal component.
 * @module pages/Scrapers/ScraperEditor
 */

import { Loader2, Wand2, Globe } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import {
  FREQUENCY_OPTIONS, DEFAULT_SCRAPER,
} from './constants'
import { getFrequencyLabel } from './scraper-helpers'
import type {
  ScraperConfig, ScraperTemplate,
} from '../../api/types'
import ModalShell from '../../components/ModalShell/ModalShell'
import { saveIgnoringFailure, useSnapshotGuard } from '../../components/UnsavedChangesGuard/useSnapshotGuard'
import SourceDialogHeader from './SourceDialogHeader'
import DimensionDefaultsSection from '../../components/DimensionFields/DimensionDefaultsSection'
import RadarSourcePicker from './RadarSourcePicker'
import {
  AnalyzeResultDisplay, CssSelectorToggle, CssSelectors, EditorFooter, HintTip, JsonLdIndicator, ReadOnlyNotice,
  type AnalyzeResult, type SectionProps,
} from './ScraperEditorParts'

interface ScraperEditorProps {
  readonly scraper: ScraperConfig | null
  readonly template?: ScraperTemplate | null
  /**
   * Whether the current user is an admin. Save (`POST /scrapers`) and Auto-detect
   * (`POST /scrapers/analyze-url`) are admin-only server-side: save writes the
   * shared scraper credentials secret and Auto-detect spends Bedrock. A non-admin still opens the editor to READ a configuration (the
   * list route serves it to them), so every field is disabled, Save and
   * Auto-detect carry the admin-only title, and a notice says why.
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

      if (result.success && result.selectors && result.selectors.detected_reviews_count > 0) {
        applyDetectedSelectors(result.selectors)
      } else if (result.success && result.selectors) {
        // Zero reviews is not a success: the selectors match nothing, and the model's
        // confidence is about selectors that found no review. Leave the draft alone.
        setAnalyzeResult({ success: false, empty: true, message: t('editor.noReviewsFound'), warnings: result.selectors.warnings })
      } else {
        setAnalyzeResult({
          success: false,
          message: result.error ?? t('editor.couldNotDetect'),
        })
      }
    } catch (error) {
      // A failed assist job throws its `error`: the server's own reason (e.g. "The site
      // refused the request (HTTP 404) ..."), which says what to fix; the generic text
      // is only for an error that carries none.
      setAnalyzeResult({
        success: false,
        message: error instanceof Error && error.message !== '' ? error.message : t('editor.failedToAnalyze'),
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
        <SourceDialogHeader titleId={titleId} title={scraper ? t('editor.editTitle') : t('editor.newTitle')} icon={Globe} onClose={close} />

        <div className="dialog-body space-y-4">
          {isAdmin ? null : <ReadOnlyNotice />}
          {/* Two fieldsets so the CSS-selector toggle between them stays usable:
              a non-admin may still look at the selectors, just not change them. */}
          <fieldset disabled={!isAdmin} className="space-y-4 min-w-0">
            <BasicSettings config={config} setConfig={setConfig} />
            <RadarSourcePicker value={config.radar_brand ?? ''} onChange={(radarBrand) => setConfig((prev) => ({ ...prev, radar_brand: radarBrand }))} />
            <UrlInput config={config} setConfig={setConfig} isAdmin={isAdmin} isAnalyzing={isAnalyzing} onAutoDetect={() => void handleAutoDetect()} />
            {analyzeResult ? <AnalyzeResultDisplay result={analyzeResult} /> : null}
            <AdditionalUrls urlInput={urlInput} setUrlInput={setUrlInput} />
            <PaginationSettings config={config} setConfig={setConfig} />
          </fieldset>
          {config.extraction_method === 'jsonld' && <JsonLdIndicator />}
          {config.extraction_method !== 'jsonld' && (
            <CssSelectorToggle showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced} />
          )}
          <fieldset disabled={!isAdmin} className="space-y-4 min-w-0">
            {showAdvanced && config.extraction_method !== 'jsonld' ? <CssSelectors config={config} setConfig={setConfig} analyzeSuccess={analyzeResult?.success} /> : null}
            <DimensionDefaultsSection
              dimensionDefaults={config.dimension_defaults}
              tags={config.tags}
              onChange={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
            />
          </fieldset>
        </div>

        <EditorFooter saveError={saveError} isSaving={isSaving} isAdmin={isAdmin} onSave={handleSave} onCancel={close} />
        {guardDialog}
    </ModalShell>
  )
}

function BasicSettings({ config, setConfig }: SectionProps) {
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
        <select id={`${id}-1`} value={config.frequency_minutes} onChange={(e) => setConfig({
          ...config,
          frequency_minutes: Number.parseInt(e.target.value),
        })} className="select disabled:opacity-50 disabled:cursor-not-allowed">
          {FREQUENCY_OPTIONS.map((minutes) => <option key={minutes.toString()} value={minutes}>{getFrequencyLabel(minutes, t)}</option>)}
        </select>
      </div>
    </div>
  )
}

function UrlInput({
  config, setConfig, isAdmin, isAnalyzing, onAutoDetect,
}: SectionProps & {
  /** Auto-detect calls `POST /scrapers/analyze-url`, which is admin-only. */
  readonly isAdmin: boolean
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
          <button onClick={onAutoDetect} disabled={isAnalyzing || config.base_url === '' || !isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-secondary whitespace-nowrap">
            {isAnalyzing ? <><Loader2 size={16} className="animate-spin" /> {t('editor.analyzing')}</> : <><Wand2 size={16} /> {t('editor.autoDetect')}</>}
          </button>
        )}
      </div>
      {showAutoDetect && <p className="text-xs text-muted mt-1">{t('editor.autoDetectHint')}</p>}
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
