import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Trash2, Play, Settings, Globe, Code, Wand2,
  Save, AlertCircle, CheckCircle, Loader2, XCircle, RefreshCw, FileJson, Info
} from 'lucide-react'
import { api } from '../api/client'
import type { ScraperConfig, ScraperTemplate } from '../api/client'
import { useConfigStore } from '../store/configStore'
import clsx from 'clsx'

const DEFAULT_SCRAPER: Omit<ScraperConfig, 'id'> = {
  name: 'New Scraper',
  enabled: true,
  base_url: '',
  urls: [],
  frequency_minutes: 60,
  extraction_method: 'css',
  container_selector: '.review',
  text_selector: '.review-text',
  title_selector: '',
  rating_selector: '',
  date_selector: '',
  author_selector: '',
  link_selector: 'a',
  pagination: { enabled: false, param: 'page', max_pages: 5, start: 1 },
}

const FREQUENCY_OPTIONS = [
  { value: 0, label: 'Manual only' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 30, label: 'Every 30 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 180, label: 'Every 3 hours' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Daily' },
]

interface RunStatus {
  status: string
  pages_scraped: number
  items_found: number
  errors: string[]
  started_at?: string
  completed_at?: string
}

function ScraperRunStatus({ scraperId, onComplete }: { scraperId: string; onComplete?: () => void }) {
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [polling, setPolling] = useState(true)

  useEffect(() => {
    if (!polling) return

    const poll = async () => {
      try {
        const result = await api.getScraperStatus(scraperId)
        setStatus(result)
        
        if (result.status === 'completed' || result.status === 'completed_with_errors' || result.status === 'error') {
          setPolling(false)
          onComplete?.()
        }
      } catch (e) {
        console.error('Failed to get status:', e)
      }
    }

    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [scraperId, polling, onComplete])

  if (!status || status.status === 'never_run') return null

  const isRunning = status.status === 'running'
  const hasErrors = status.errors?.length > 0

  return (
    <div className={clsx(
      'mt-3 p-3 rounded-lg text-sm',
      isRunning ? 'bg-blue-50 border border-blue-200' :
      status.status === 'error' ? 'bg-red-50 border border-red-200' :
      hasErrors ? 'bg-amber-50 border border-amber-200' :
      'bg-green-50 border border-green-200'
    )}>
      <div className="flex items-center gap-2 mb-2">
        {isRunning ? (
          <><Loader2 size={16} className="animate-spin text-blue-600" /><span className="font-medium text-blue-700">Running...</span></>
        ) : status.status === 'error' ? (
          <><XCircle size={16} className="text-red-600" /><span className="font-medium text-red-700">Failed</span></>
        ) : hasErrors ? (
          <><AlertCircle size={16} className="text-amber-600" /><span className="font-medium text-amber-700">Completed with errors</span></>
        ) : (
          <><CheckCircle size={16} className="text-green-600" /><span className="font-medium text-green-700">Completed</span></>
        )}
      </div>
      
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>Pages scraped: <span className="font-semibold">{status.pages_scraped}</span></div>
        <div>Reviews found: <span className="font-semibold">{status.items_found}</span></div>
      </div>

      {hasErrors && (
        <div className="mt-2 text-xs text-red-600">
          {status.errors.slice(0, 2).map((err, i) => (
            <div key={i} className="truncate">{err}</div>
          ))}
          {status.errors.length > 2 && <div>...and {status.errors.length - 2} more errors</div>}
        </div>
      )}
    </div>
  )
}


function ScraperCard({ scraper, onEdit, onDelete, onRun }: {
  scraper: ScraperConfig
  onEdit: () => void
  onDelete: () => void
  onRun: () => void
}) {
  const [showStatus, setShowStatus] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastRunInfo, setLastRunInfo] = useState<RunStatus | null>(null)
  const domain = scraper.base_url ? new URL(scraper.base_url).hostname : 'Not configured'

  // Fetch last run info on mount
  useEffect(() => {
    const fetchLastRun = async () => {
      try {
        const result = await api.getScraperStatus(scraper.id)
        if (result.status !== 'never_run') {
          setLastRunInfo(result)
        }
      } catch (e) {
        console.error('Failed to get last run:', e)
      }
    }
    fetchLastRun()
  }, [scraper.id])

  const handleRun = () => {
    setIsRunning(true)
    setShowStatus(true)
    onRun()
  }

  // Calculate total URLs (base + pagination + additional)
  const totalUrls = () => {
    let count = scraper.urls?.length || 0
    if (scraper.base_url) {
      count += 1
      if (scraper.pagination?.enabled) {
        count += (scraper.pagination.max_pages - 1)
      }
    }
    return count
  }

  return (
    <div className={clsx(
      'card border-2 transition-all',
      scraper.enabled ? 'border-green-200 bg-green-50/30' : 'border-gray-200 opacity-60'
    )}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={clsx(
            'w-10 h-10 rounded-lg flex items-center justify-center',
            scraper.enabled ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'
          )}>
            <Globe size={20} />
          </div>
          <div>
            <h3 className="font-semibold">{scraper.name}</h3>
            <p className="text-sm text-gray-500">{domain}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button 
            onClick={handleRun} 
            disabled={isRunning || !scraper.base_url}
            className={clsx(
              "p-2 rounded transition-colors",
              isRunning ? "bg-blue-100 text-blue-600" : "hover:bg-green-100 text-green-600"
            )}
            title="Run now"
          >
            {isRunning ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          </button>
          <button onClick={onEdit} className="p-2 hover:bg-gray-100 rounded" title="Edit">
            <Settings size={16} />
          </button>
          <button onClick={onDelete} className="p-2 hover:bg-gray-100 rounded text-red-500" title="Delete">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 text-sm">
        <div>
          <span className="text-gray-500">Frequency</span>
          <p className="font-medium">{FREQUENCY_OPTIONS.find(f => f.value === scraper.frequency_minutes)?.label || `${scraper.frequency_minutes}m`}</p>
        </div>
        <div>
          <span className="text-gray-500">URLs</span>
          <p className="font-medium">{totalUrls()}</p>
        </div>
        <div>
          <span className="text-gray-500">Last Run</span>
          <p className="font-medium">{lastRunInfo?.started_at ? new Date(lastRunInfo.started_at).toLocaleDateString() : 'Never'}</p>
        </div>
      </div>

      {/* Last run summary */}
      {lastRunInfo && lastRunInfo.status !== 'never_run' && !showStatus && (
        <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
          <div className="flex items-center justify-between">
            <span>Last: {lastRunInfo.pages_scraped} pages, {lastRunInfo.items_found} reviews</span>
            <span className={clsx(
              'px-2 py-0.5 rounded',
              lastRunInfo.status === 'completed' ? 'bg-green-100 text-green-700' :
              lastRunInfo.status === 'completed_with_errors' ? 'bg-amber-100 text-amber-700' :
              lastRunInfo.status === 'error' ? 'bg-red-100 text-red-700' :
              'bg-gray-100 text-gray-600'
            )}>
              {lastRunInfo.status === 'completed' ? '✓' : lastRunInfo.status === 'completed_with_errors' ? '⚠' : lastRunInfo.status === 'error' ? '✗' : '?'}
            </span>
          </div>
          {lastRunInfo.errors && lastRunInfo.errors.length > 0 && (
            <p className="text-red-500 truncate mt-1" title={lastRunInfo.errors[0]}>{lastRunInfo.errors[0]}</p>
          )}
        </div>
      )}

      {showStatus && (
        <ScraperRunStatus 
          scraperId={scraper.id} 
          onComplete={() => {
            setIsRunning(false)
            // Refresh last run info
            api.getScraperStatus(scraper.id).then(result => {
              if (result.status !== 'never_run') setLastRunInfo(result)
            })
          }}
        />
      )}
    </div>
  )
}


function ScraperEditor({ scraper, template, onSave, onClose }: {
  scraper: ScraperConfig | null
  template?: ScraperTemplate | null
  onSave: (scraper: ScraperConfig) => void
  onClose: () => void
}) {
  // Build initial config from template if provided
  const buildInitialConfig = (): ScraperConfig => {
    if (scraper) return scraper
    
    const base: ScraperConfig = { ...DEFAULT_SCRAPER, id: `scraper_${Date.now()}` }
    
    if (template) {
      return {
        ...base,
        name: template.name.replace(/\s*\(.*\)/, ''), // Remove "(JSON-LD)" etc
        extraction_method: template.extraction_method,
        template: template.id,
        base_url: template.url_placeholder,
        pagination: template.pagination ?? DEFAULT_SCRAPER.pagination,
        ...template.config,
      }
    }
    
    return base
  }

  const [config, setConfig] = useState<ScraperConfig>(buildInitialConfig())
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [urlInput, setUrlInput] = useState(config.urls.join('\n'))
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analyzeResult, setAnalyzeResult] = useState<{ success: boolean; message?: string; confidence?: string; warnings?: string[] } | null>(null)

  const handleSave = () => {
    const urls = urlInput.split('\n').map(u => u.trim()).filter(Boolean)
    onSave({ ...config, urls })
  }

  const handleAutoDetect = async () => {
    if (!config.base_url) {
      setAnalyzeResult({ success: false, message: 'Enter a URL first' })
      return
    }

    setIsAnalyzing(true)
    setAnalyzeResult(null)

    try {
      const result = await api.analyzeUrlForSelectors(config.base_url)
      
      if (result.success && result.selectors) {
        // Build rating selector - if rating is in an attribute, include it
        let ratingSelector = result.selectors.rating_selector || ''
        if (result.selectors.rating_attribute && ratingSelector) {
          ratingSelector = `${ratingSelector}@${result.selectors.rating_attribute}`
        }
        
        setConfig(prev => ({
          ...prev,
          container_selector: result.selectors!.container_selector || prev.container_selector,
          text_selector: result.selectors!.text_selector || prev.text_selector,
          title_selector: result.selectors!.title_selector || '',
          rating_selector: ratingSelector,
          date_selector: result.selectors!.date_selector || '',
          author_selector: result.selectors!.author_selector || '',
        }))
        setShowAdvanced(true)
        setAnalyzeResult({ 
          success: true, 
          message: `Found ${result.selectors.detected_reviews_count || 'some'} reviews. ${result.selectors.notes || ''}`,
          confidence: result.selectors.confidence,
          warnings: result.selectors.warnings
        })
      } else {
        setAnalyzeResult({ success: false, message: result.message || 'Could not detect selectors' })
      }
    } catch (e) {
      setAnalyzeResult({ success: false, message: 'Failed to analyze URL' })
    } finally {
      setIsAnalyzing(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="font-semibold text-lg">{scraper ? 'Edit Scraper' : 'New Scraper'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Scraper Name</label>
              <input
                type="text"
                value={config.name}
                onChange={e => setConfig({ ...config, name: e.target.value })}
                className="input"
                placeholder="My Review Scraper"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Frequency</label>
              <select
                value={config.frequency_minutes}
                onChange={e => setConfig({ ...config, frequency_minutes: parseInt(e.target.value) })}
                className="input"
              >
                {FREQUENCY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Website URL</label>
            <div className="flex gap-2">
              <input
                type="url"
                value={config.base_url}
                onChange={e => setConfig({ ...config, base_url: e.target.value })}
                className="input flex-1"
                placeholder="https://example.com/reviews"
              />
              <button
                onClick={handleAutoDetect}
                disabled={isAnalyzing || !config.base_url}
                className="btn btn-secondary flex items-center gap-2 whitespace-nowrap"
              >
                {isAnalyzing ? (
                  <><Loader2 size={16} className="animate-spin" /> Analyzing...</>
                ) : (
                  <><Wand2 size={16} /> Auto-detect</>
                )}
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">Enter the reviews page URL and click Auto-detect to find CSS selectors automatically</p>
          </div>

          {analyzeResult && (
            <div className={clsx(
              'p-3 rounded-lg text-sm flex items-start gap-2',
              analyzeResult.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
            )}>
              {analyzeResult.success ? <CheckCircle size={18} className="shrink-0 mt-0.5" /> : <AlertCircle size={18} className="shrink-0 mt-0.5" />}
              <div>
                <p>{analyzeResult.message}</p>
                {analyzeResult.confidence && (
                  <p className="text-xs mt-1 opacity-75">Confidence: {analyzeResult.confidence}</p>
                )}
                {analyzeResult.warnings && analyzeResult.warnings.length > 0 && (
                  <div className="mt-2 text-xs text-amber-700 bg-amber-50 p-2 rounded">
                    <p className="font-medium mb-1">⚠️ Warnings:</p>
                    <ul className="list-disc list-inside space-y-0.5">
                      {analyzeResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center gap-2 mb-1">
              <label className="block text-sm font-medium">Additional URLs (one per line)</label>
              <div className="group relative">
                <Info size={14} className="text-gray-400 cursor-help" />
                <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 p-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg z-10">
                  Use this for scraping unrelated pages (e.g., different products). These URLs are scraped in addition to the base URL and any paginated pages.
                </div>
              </div>
            </div>
            <textarea
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              className="input min-h-[80px] font-mono text-sm"
              placeholder="https://example.com/other-product/reviews"
            />
            <p className="text-xs text-gray-500 mt-1">Optional. Add extra URLs to scrape alongside the main URL.</p>
          </div>

          {/* Pagination */}
          <div className="border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.pagination.enabled}
                  onChange={e => setConfig({
                    ...config,
                    pagination: { ...config.pagination, enabled: e.target.checked }
                  })}
                  className="rounded"
                />
                <span className="font-medium">Enable Pagination</span>
              </label>
              <div className="group relative">
                <Info size={14} className="text-gray-400 cursor-help" />
                <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-72 p-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg z-10">
                  Automatically scrapes multiple pages by appending ?page=2, ?page=3, etc. to the base URL. Set "Max Pages" to control how many pages to scrape.
                </div>
              </div>
            </div>
            {config.pagination.enabled && (
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Page Parameter</label>
                  <input
                    type="text"
                    value={config.pagination.param}
                    onChange={e => setConfig({
                      ...config,
                      pagination: { ...config.pagination, param: e.target.value }
                    })}
                    className="input text-sm"
                    placeholder="page"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Start Page</label>
                  <input
                    type="number"
                    value={config.pagination.start}
                    onChange={e => setConfig({
                      ...config,
                      pagination: { ...config.pagination, start: parseInt(e.target.value) || 1 }
                    })}
                    className="input text-sm"
                    min={0}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Max Pages</label>
                  <input
                    type="number"
                    value={config.pagination.max_pages}
                    onChange={e => setConfig({
                      ...config,
                      pagination: { ...config.pagination, max_pages: parseInt(e.target.value) || 5 }
                    })}
                    className="input text-sm"
                    min={1}
                    max={50}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Extraction Method Indicator */}
          {config.extraction_method === 'jsonld' && (
            <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-sm">
              <div className="flex items-center gap-2 text-green-800 font-medium mb-1">
                <FileJson size={16} /> JSON-LD Extraction
              </div>
              <p className="text-green-700">
                This scraper uses structured data (Schema.org) embedded in the page. No CSS selectors needed - reviews are extracted automatically from JSON-LD.
              </p>
            </div>
          )}

          {/* CSS Selectors - only show for CSS extraction method */}
          {config.extraction_method !== 'jsonld' && (
            <div>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-sm font-medium text-blue-600"
              >
                <Code size={16} />
                {showAdvanced ? 'Hide' : 'Show'} CSS Selectors
              </button>
            </div>
          )}

          {showAdvanced && config.extraction_method !== 'jsonld' && (
            <div className="border rounded-lg p-4 space-y-3 bg-gray-50">
              <p className="text-sm text-gray-600 mb-3">
                These selectors were {analyzeResult?.success ? 'auto-detected' : 'set to defaults'}. Adjust if needed.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Review Container *</label>
                  <input
                    type="text"
                    value={config.container_selector}
                    onChange={e => setConfig({ ...config, container_selector: e.target.value })}
                    className="input text-sm font-mono"
                    placeholder=".review"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Text Content *</label>
                  <input
                    type="text"
                    value={config.text_selector}
                    onChange={e => setConfig({ ...config, text_selector: e.target.value })}
                    className="input text-sm font-mono"
                    placeholder=".review-text"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Title</label>
                  <input
                    type="text"
                    value={config.title_selector || ''}
                    onChange={e => setConfig({ ...config, title_selector: e.target.value || undefined })}
                    className="input text-sm font-mono"
                    placeholder=".review-title"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Rating</label>
                  <input
                    type="text"
                    value={config.rating_selector || ''}
                    onChange={e => setConfig({ ...config, rating_selector: e.target.value || undefined })}
                    className="input text-sm font-mono"
                    placeholder=".stars"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Date</label>
                  <input
                    type="text"
                    value={config.date_selector || ''}
                    onChange={e => setConfig({ ...config, date_selector: e.target.value || undefined })}
                    className="input text-sm font-mono"
                    placeholder="time"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Author</label>
                  <input
                    type="text"
                    value={config.author_selector || ''}
                    onChange={e => setConfig({ ...config, author_selector: e.target.value || undefined })}
                    className="input text-sm font-mono"
                    placeholder=".author"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button onClick={handleSave} className="btn btn-primary flex items-center gap-2">
            <Save size={16} /> Save Scraper
          </button>
        </div>
      </div>
    </div>
  )
}


function TemplateSelector({ onSelect, onClose }: {
  onSelect: (template: ScraperTemplate) => void
  onClose: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['scraper-templates'],
    queryFn: api.getScraperTemplates,
  })

  const templates = data?.templates || []

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="font-semibold text-lg">Choose a Template</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="animate-spin h-8 w-8 text-blue-500" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {templates.map(template => (
                <button
                  key={template.id}
                  onClick={() => onSelect(template)}
                  className={clsx(
                    'p-4 border-2 rounded-lg text-left transition-all hover:border-blue-400 hover:bg-blue-50',
                    template.extraction_method === 'jsonld' ? 'border-green-200 bg-green-50/30' : 'border-gray-200'
                  )}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-2xl">{template.icon}</span>
                    <div>
                      <h4 className="font-semibold">{template.name}</h4>
                      {template.extraction_method === 'jsonld' && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full flex items-center gap-1 w-fit">
                          <FileJson size={12} /> JSON-LD
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-gray-600">{template.description}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t bg-gray-50">
          <p className="text-sm text-gray-600">
            <span className="font-medium text-green-700">💡 Tip:</span> JSON-LD templates are more reliable as they extract structured data that websites provide for search engines.
          </p>
        </div>
      </div>
    </div>
  )
}


export default function Scrapers() {
  const { config } = useConfigStore()
  const queryClient = useQueryClient()
  const [editingScraper, setEditingScraper] = useState<ScraperConfig | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<ScraperTemplate | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['scrapers'],
    queryFn: api.getScrapers,
    enabled: !!config.apiEndpoint,
  })

  const scrapers = data?.scrapers || []

  const handleSelectTemplate = (template: ScraperTemplate) => {
    setSelectedTemplate(template)
    setShowTemplates(false)
    setIsCreating(true)
  }

  const saveMutation = useMutation({
    mutationFn: (scraper: ScraperConfig) => api.saveScraper(scraper),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scrapers'] })
    }
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteScraper(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scrapers'] })
    }
  })

  const runMutation = useMutation({
    mutationFn: (id: string) => api.runScraper(id),
  })

  const handleSaveScraper = (scraper: ScraperConfig) => {
    saveMutation.mutate(scraper)
    setEditingScraper(null)
    setIsCreating(false)
  }

  const handleDeleteScraper = (id: string) => {
    if (!confirm('Delete this scraper?')) return
    deleteMutation.mutate(id)
  }

  const handleRunScraper = (id: string) => {
    runMutation.mutate(id)
  }

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-amber-500 mb-4" />
          <p className="text-gray-500 mb-4">Configure API endpoint first</p>
          <a href="/settings" className="btn btn-primary">Go to Settings</a>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Web Scrapers</h1>
          <p className="text-gray-500">Configure custom scrapers to extract feedback from any website</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()} className="btn btn-secondary flex items-center gap-2">
            <RefreshCw size={16} /> Refresh
          </button>
          <button
            onClick={() => setShowTemplates(true)}
            className="btn btn-primary flex items-center gap-2"
          >
            <Plus size={16} /> New Scraper
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin h-8 w-8 text-blue-500" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {scrapers.map(scraper => (
            <ScraperCard
              key={scraper.id}
              scraper={scraper}
              onEdit={() => setEditingScraper(scraper)}
              onDelete={() => handleDeleteScraper(scraper.id)}
              onRun={() => handleRunScraper(scraper.id)}
            />
          ))}
        </div>
      )}

      {!isLoading && scrapers.length === 0 && (
        <div className="card text-center py-12">
          <Globe className="mx-auto h-12 w-12 text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No scrapers configured</h3>
          <p className="text-gray-500 mb-4">Create your first web scraper to start collecting feedback</p>
          <button onClick={() => setIsCreating(true)} className="btn btn-primary">
            Create Scraper
          </button>
        </div>
      )}

      <div className="card bg-blue-50 border-blue-200">
        <h3 className="font-semibold text-blue-900 mb-3">How It Works</h3>
        <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
          <li>Enter the URL of a reviews or feedback page</li>
          <li>Click <span className="font-medium">Auto-detect</span> to let AI find the CSS selectors</li>
          <li>Review the detected selectors and adjust if needed</li>
          <li>Save and click <span className="font-medium">Play</span> to run immediately, or wait for scheduled runs</li>
        </ol>
      </div>

      {showTemplates && (
        <TemplateSelector
          onSelect={handleSelectTemplate}
          onClose={() => setShowTemplates(false)}
        />
      )}

      {(editingScraper || isCreating) && (
        <ScraperEditor
          scraper={editingScraper}
          template={selectedTemplate}
          onSave={handleSaveScraper}
          onClose={() => { setEditingScraper(null); setIsCreating(false); setSelectedTemplate(null) }}
        />
      )}
    </div>
  )
}
