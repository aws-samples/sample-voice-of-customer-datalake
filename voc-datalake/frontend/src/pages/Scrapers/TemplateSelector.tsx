/**
 * @fileoverview Template selector modal component.
 * @module pages/Scrapers/TemplateSelector
 * 
 * Shows web scraper templates AND auto-discovered plugins (e.g. iOS/Android)
 * so users can configure all data sources from the Scrapers page.
 */

import { useQuery } from '@tanstack/react-query'
import { Loader2, FileJson, Globe, Smartphone, ClipboardPaste, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import type { ScraperTemplate } from '../../api/client'
import type { PluginManifest } from '../../plugins/types'
import { getPluginManifests } from '../../plugins'
import { useConfigStore } from '../../store/configStore'
import clsx from 'clsx'

interface TemplateSelectorProps {
  readonly onSelect: (template: ScraperTemplate) => void
  readonly onSelectPlugin: (plugin: PluginManifest) => void
  readonly onManualImport: () => void
  readonly onJsonUpload: () => void
  readonly onClose: () => void
}

/**
 * Built-in web scraper templates. These are always available regardless of
 * API connectivity — they mirror what the backend returns from GET /scrapers/templates.
 */
const BUILTIN_TEMPLATES: ScraperTemplate[] = [
  {
    id: 'review_jsonld',
    name: 'Review JSON-LD',
    description: 'Extract reviews using JSON-LD structured data.',
    icon: '⭐',
    extraction_method: 'jsonld',
    url_pattern: '',
    url_placeholder: '',
    supports_pagination: true,
    pagination: { enabled: true, param: 'page', max_pages: 10, start: 1 },
    config: {
      extraction_method: 'jsonld',
      template: 'review_jsonld',
      pagination: { enabled: true, param: 'page', max_pages: 10, start: 1 },
    },
  },
  {
    id: 'custom_css',
    name: 'Custom (CSS Selectors)',
    description: 'Create a custom scraper with CSS selectors.',
    icon: '🔧',
    extraction_method: 'css',
    url_pattern: '',
    url_placeholder: '',
    supports_pagination: true,
    pagination: { enabled: false, param: 'page', max_pages: 10, start: 1 },
    config: {
      extraction_method: 'css',
      container_selector: '.review',
      text_selector: '.review-text',
      pagination: { enabled: false, param: 'page', max_pages: 10, start: 1 },
    },
  },
]

/** Get icon component for a plugin based on its icon string */
function PluginIcon({ icon }: { readonly icon: string }) {
  if (icon === 'iOS' || icon === 'Android') {
    return <Smartphone size={24} className="text-gray-600" />
  }
  return <Globe size={24} className="text-gray-600" />
}

/** Get the color scheme for a plugin category */
function getPluginBorderClass(category?: string): string {
  if (category === 'reviews') return 'border-purple-200 bg-purple-50/30'
  return 'border-gray-200'
}

/**
 * Get auto-discovered plugins that should appear in the template selector.
 * Excludes the webscraper plugin (it has its own templates) and only includes
 * plugins with an ingestor (scheduled data collection).
 */
function getDiscoverablePlugins(): PluginManifest[] {
  return getPluginManifests().filter(
    p => p.id !== 'webscraper' && p.hasIngestor
  )
}

/**
 * Merge API templates with built-in fallbacks.
 * API templates take precedence (by id) over built-ins.
 */
function mergeTemplates(apiTemplates: ScraperTemplate[]): ScraperTemplate[] {
  if (apiTemplates.length > 0) return apiTemplates
  return BUILTIN_TEMPLATES
}

export default function TemplateSelector({ onSelect, onSelectPlugin, onManualImport, onJsonUpload, onClose }: TemplateSelectorProps) {
  const { t } = useTranslation('scrapers')
  const { config } = useConfigStore()

  const { data, isLoading } = useQuery({
    queryKey: ['scraper-templates'],
    queryFn: api.getScraperTemplates,
    enabled: !!config.apiEndpoint,
  })

  const templates = mergeTemplates(data?.templates ?? [])
  const discoverablePlugins = getDiscoverablePlugins()

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-3 sm:p-4 border-b flex items-center justify-between">
          <h3 className="font-semibold text-base sm:text-lg">{t('templateSelector.title')}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
        </div>

        <div className="p-3 sm:p-4 overflow-y-auto flex-1 space-y-6">
          {/* Auto-discovered plugins section */}
          {discoverablePlugins.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{t('templateSelector.appReviewSources')}</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {discoverablePlugins.map(plugin => (
                  <button
                    key={plugin.id}
                    onClick={() => onSelectPlugin(plugin)}
                    className={clsx(
                      'p-3 sm:p-4 border-2 rounded-lg text-left transition-all hover:border-purple-400 hover:bg-purple-50',
                      getPluginBorderClass(plugin.category)
                    )}
                  >
                    <div className="flex items-center gap-2 sm:gap-3 mb-2">
                      <PluginIcon icon={plugin.icon} />
                      <div>
                        <div className="font-medium text-sm sm:text-base">{plugin.name}</div>
                        <span className="inline-flex items-center gap-1 text-xs text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">
                          {t('templateSelector.autoDiscovered')}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs sm:text-sm text-gray-600">{plugin.description}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Web scraper templates section */}
          <div>
            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{t('templateSelector.webScraperTemplates')}</h4>
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="animate-spin h-8 w-8 text-blue-500" />
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {templates.map(template => (
                  <button
                    key={template.id}
                    onClick={() => onSelect(template)}
                    className={clsx(
                      'p-3 sm:p-4 border-2 rounded-lg text-left transition-all hover:border-blue-400 hover:bg-blue-50',
                      template.extraction_method === 'jsonld' ? 'border-green-200 bg-green-50/30' : 'border-gray-200'
                    )}
                  >
                    <div className="flex items-center gap-2 sm:gap-3 mb-2">
                      <span className="text-xl sm:text-2xl">{template.icon}</span>
                      <div>
                        <div className="font-medium text-sm sm:text-base">{template.name}</div>
                        {template.extraction_method === 'jsonld' && (
                          <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-1.5 py-0.5 rounded">
                            <FileJson size={10} /> JSON-LD
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-xs sm:text-sm text-gray-600">{template.description}</p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Manual Import section */}
          <div>
            <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{t('templateSelector.manualInput')}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              <button
                onClick={onManualImport}
                className="p-3 sm:p-4 border-2 rounded-lg text-left transition-all hover:border-amber-400 hover:bg-amber-50 border-amber-200 bg-amber-50/30"
              >
                <div className="flex items-center gap-2 sm:gap-3 mb-2">
                  <ClipboardPaste size={24} className="text-amber-600" />
                  <div className="font-medium text-sm sm:text-base">{t('templateSelector.manualImport')}</div>
                </div>
                <p className="text-xs sm:text-sm text-gray-600">{t('templateSelector.manualImportDescription')}</p>
              </button>
              <button
                onClick={onJsonUpload}
                className="p-3 sm:p-4 border-2 rounded-lg text-left transition-all hover:border-blue-400 hover:bg-blue-50 border-blue-200 bg-blue-50/30"
              >
                <div className="flex items-center gap-2 sm:gap-3 mb-2">
                  <Upload size={24} className="text-blue-600" />
                  <div className="font-medium text-sm sm:text-base">{t('templateSelector.jsonUpload')}</div>
                </div>
                <p className="text-xs sm:text-sm text-gray-600">{t('templateSelector.jsonUploadDescription')}</p>
              </button>
            </div>
          </div>
        </div>

        <div className="p-3 sm:p-4 border-t">
          <button onClick={onClose} className="btn btn-secondary w-full text-sm">{t('templateSelector.cancel')}</button>
        </div>
      </div>
    </div>
  )
}
