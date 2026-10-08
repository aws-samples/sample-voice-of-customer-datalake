/**
 * @fileoverview Template selector modal component.
 * @module pages/Scrapers/TemplateSelector
 *
 * Shows web scraper templates AND auto-discovered plugins (e.g. iOS/Android)
 * so users can configure all data sources from the Scrapers page.
 */

import { useQuery } from '@tanstack/react-query'
import { FileJson, ClipboardPaste, Upload, FlaskConical, FileText, Code2, Plus, type LucideIcon } from 'lucide-react'
import { manifestIcon } from '../../components/SourceIcon/sourceIcons'
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { scrapersApi } from '../../api/scrapersApi'
import { getPluginManifests, getSyntheticPlugins } from '../../plugins'
import { useConfigStore } from '../../store/configStore'
import type { ScraperTemplate } from '../../api/types'
import type { PluginManifest } from '../../plugins/types'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceDialogHeader, { ToneTile, type SourceTone } from './SourceDialogHeader'

interface TemplateSelectorProps {
  readonly onSelect: (template: ScraperTemplate) => void
  readonly onSelectPlugin: (plugin: PluginManifest) => void
  readonly onSelectGenerator: (plugin: PluginManifest) => void
  readonly onManualImport: () => void
  readonly onJsonUpload: () => void
  readonly onCsvUpload: () => void
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
    icon: 'JSON-LD',
    extraction_method: 'jsonld',
    url_pattern: '',
    url_placeholder: '',
    supports_pagination: true,
    pagination: {
      enabled: true,
      param: 'page',
      max_pages: 10,
      start: 1,
    },
    config: {
      extraction_method: 'jsonld',
      template: 'review_jsonld',
      pagination: {
        enabled: true,
        param: 'page',
        max_pages: 10,
        start: 1,
      },
    },
  },
  {
    id: 'custom_css',
    name: 'Custom (CSS Selectors)',
    description: 'Create a custom scraper with CSS selectors.',
    icon: 'CSS',
    extraction_method: 'css',
    url_pattern: '',
    url_placeholder: '',
    supports_pagination: true,
    pagination: {
      enabled: false,
      param: 'page',
      max_pages: 10,
      start: 1,
    },
    config: {
      extraction_method: 'css',
      container_selector: '.review',
      text_selector: '.review-text',
      pagination: {
        enabled: false,
        param: 'page',
        max_pages: 10,
        start: 1,
      },
    },
  },
]

/** Icon (the shared manifest-word map, components/SourceIcon) + tone for a discovered plugin. */
function pluginVisual(plugin: PluginManifest): { icon: LucideIcon; tone: SourceTone } {
  return { icon: manifestIcon(plugin.icon, plugin.category), tone: plugin.category === 'import' ? 'info' : 'accent' }
}

/** Web scraper templates: JSON-LD (structured data) vs hand-written CSS selectors. */
function templateVisual(template: ScraperTemplate): { icon: LucideIcon; tone: SourceTone } {
  return template.extraction_method === 'jsonld'
    ? { icon: FileJson, tone: 'ok' }
    : { icon: Code2, tone: 'muted' }
}

/**
 * One selectable source. Every tile has the same neutral surface; the kind of
 * source is carried by the icon tile's tone (it used to be five different
 * tinted fills and borders, which read as five different states).
 */
function SourceTile({ icon, tone, title, badge, description, onClick }: Readonly<{
  icon: LucideIcon
  tone: SourceTone
  title: string
  badge?: ReactNode
  description?: string
  onClick: () => void
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-start gap-3 p-3 sm:p-4 rounded-lg border border-border bg-card text-left transition-colors hover:border-border-strong hover:bg-bg-hover focus-ring"
    >
      <ToneTile icon={icon} tone={tone} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-text-strong">{title}</span>
          {badge}
        </span>
        {description != null && description !== '' ? <span className="block text-xs text-muted mt-1">{description}</span> : null}
      </span>
      <Plus size={16} className="text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" aria-hidden="true" />
    </button>
  )
}

function TileSection({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted mb-2">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">{children}</div>
    </section>
  )
}

/**
 * Get auto-discovered plugins that should appear in the template selector.
 * Excludes the webscraper plugin (it has its own templates), synthetic generators
 * (shown in their own section), and only includes plugins with an ingestor.
 * Enabled only: a disabled plugin (`pluginStatus` false) has no deployed
 * ingestor, so offering it as a source to configure leads nowhere.
 */
function getDiscoverablePlugins(): PluginManifest[] {
  return getPluginManifests().filter(
    (p) => p.enabled && p.id !== 'webscraper' && p.category !== 'synthetic' && p.hasIngestor,
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

export default function TemplateSelector({
  onSelect, onSelectPlugin, onSelectGenerator, onManualImport, onJsonUpload, onCsvUpload, onClose,
}: TemplateSelectorProps) {
  const { t } = useTranslation('scrapers')
  const { config } = useConfigStore()

  const titleId = useId()

  // No loading state: the built-in templates are always available, so they are
  // shown at once and replaced if the API returns its own. Waiting on the query
  // left a spinner up for the whole retry back-off whenever the route failed.
  const { data } = useQuery({
    queryKey: ['scraper-templates'],
    queryFn: scrapersApi.getScraperTemplates,
    enabled: config.apiEndpoint.length > 0,
  })

  const templates = mergeTemplates(data?.templates ?? [])
  const discoverablePlugins = getDiscoverablePlugins()
  const syntheticPlugins = getSyntheticPlugins()

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-3xl max-h-[95vh] sm:max-h-[90vh]">
      <SourceDialogHeader titleId={titleId} title={t('templateSelector.title')} icon={Plus} tone="accent" onClose={onClose} />

      <div className="dialog-body space-y-5">
        {discoverablePlugins.length > 0 && (
          <TileSection title={t('templateSelector.appReviewSources')}>
            {discoverablePlugins.map((plugin) => (
              <SourceTile
                key={plugin.id}
                {...pluginVisual(plugin)}
                title={plugin.name}
                badge={<span className="badge badge-accent">{t('templateSelector.autoDiscovered')}</span>}
                description={plugin.description}
                onClick={() => onSelectPlugin(plugin)}
              />
            ))}
          </TileSection>
        )}

        <TileSection title={t('templateSelector.webScraperTemplates')}>
          {templates.map((template) => (
            <SourceTile
              key={template.id}
              {...templateVisual(template)}
              title={template.name}
              badge={template.extraction_method === 'jsonld' ? <span className="badge badge-ok">JSON-LD</span> : undefined}
              description={template.description}
              onClick={() => onSelect(template)}
            />
          ))}
        </TileSection>

        <TileSection title={t('templateSelector.manualInput')}>
          <SourceTile icon={ClipboardPaste} tone="warn" title={t('templateSelector.manualImport')} description={t('templateSelector.manualImportDescription')} onClick={onManualImport} />
          <SourceTile icon={Upload} tone="info" title={t('templateSelector.jsonUpload')} description={t('templateSelector.jsonUploadDescription')} onClick={onJsonUpload} />
          <SourceTile icon={FileText} tone="ok" title={t('templateSelector.csvUpload')} description={t('templateSelector.csvUploadDescription')} onClick={onCsvUpload} />
        </TileSection>

        {syntheticPlugins.length > 0 && (
          <TileSection title={t('templateSelector.syntheticData')}>
            {syntheticPlugins.map((plugin) => (
              <SourceTile key={plugin.id} icon={FlaskConical} tone="aim" title={plugin.name} description={plugin.description} onClick={() => onSelectGenerator(plugin)} />
            ))}
          </TileSection>
        )}
      </div>

      <div className="dialog-footer">
        <button type="button" onClick={onClose} className="btn btn-secondary">{t('templateSelector.cancel')}</button>
      </div>
    </ModalShell>
  )
}
