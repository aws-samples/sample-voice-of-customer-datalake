/**
 * @fileoverview Presentational pieces of the scraper editor (`ScraperEditor.tsx`):
 * the read-only notice, analyze result, selector inputs, hint tip and footer.
 * @module pages/Scrapers/ScraperEditorParts
 */

import clsx from 'clsx'
import { Save, AlertCircle, AlertTriangle, CheckCircle, Loader2, Code, FileJson, Info, Lock } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import type { ScraperConfig } from '../../api/types'

export interface AnalyzeResult {
  success: boolean
  /** The analysis ran but found no review: a neutral warning, never "success". */
  empty?: boolean
  message?: string
  confidence?: string
  warnings?: string[]
}

/** Props shared by the editor's form sections: the draft config and its setter. */
export interface SectionProps {
  readonly config: ScraperConfig
  readonly setConfig: (c: ScraperConfig) => void
}

/** Why a non-admin sees the editor read-only (Save and Auto-detect are admin-gated). */
export function ReadOnlyNotice() {
  const { t } = useTranslation('scrapers')
  return (
    <div role="note" className="p-3 rounded-lg text-sm flex items-start gap-2 bg-info-subtle text-info">
      <Lock size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <p>{t('editor.adminOnlyNotice')}</p>
    </div>
  )
}

type AnalyzeTone = 'ok' | 'warn' | 'danger'

const TONE_STYLES: Record<AnalyzeTone, { className: string; Icon: typeof CheckCircle }> = {
  ok: { className: 'bg-ok-subtle text-ok', Icon: CheckCircle },
  warn: { className: 'bg-warn-subtle text-warn', Icon: AlertTriangle },
  danger: { className: 'bg-danger-subtle text-danger', Icon: AlertCircle },
}

function analyzeTone(result: AnalyzeResult): AnalyzeTone {
  if (result.success) return 'ok'
  return result.empty === true ? 'warn' : 'danger'
}

export function AnalyzeResultDisplay({ result }: { readonly result: AnalyzeResult }) {
  const { t } = useTranslation('scrapers')
  const tone = analyzeTone(result)
  const { className, Icon } = TONE_STYLES[tone]
  return (
    <div role="status" data-tone={tone} className={clsx('p-3 rounded-lg text-sm flex items-start gap-2', className)}>
      <Icon size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
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

/** The save error (if any), then Cancel and Save. Save is admin-only (`POST /scrapers`). */
export function EditorFooter({ saveError, isSaving, isAdmin, onSave, onCancel }: Readonly<{
  saveError: string | null
  isSaving: boolean
  isAdmin: boolean
  onSave: () => void
  onCancel: () => void
}>) {
  const { t } = useTranslation('scrapers')
  return (
    <>
      {saveError == null ? null : (
        <div role="alert" className="mx-4 mb-2 p-3 rounded-lg text-sm flex items-start gap-2 bg-danger-subtle text-danger">
          <AlertCircle size={18} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p>{saveError}</p>
        </div>
      )}
      <div className="dialog-footer flex-col-reverse sm:flex-row">
        <button onClick={onCancel} className="btn btn-secondary">{t('editor.cancel')}</button>
        <button onClick={onSave} className="btn btn-primary" disabled={isSaving || !isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE}>
          {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} {t('editor.save')}
        </button>
      </div>
    </>
  )
}

export function JsonLdIndicator() {
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

export function CssSelectorToggle({
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

export function CssSelectors({
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
export function HintTip({ text }: { readonly text: string }) {
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
