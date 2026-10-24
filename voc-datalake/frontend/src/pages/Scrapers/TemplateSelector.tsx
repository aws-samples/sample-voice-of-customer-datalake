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
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { getPluginManifests, getSyntheticPlugins } from '../../plugins'
import { useConfigStore } from '../../store/configStore'
import type { ScraperTemplate } from '../../api/types'
import type { PluginManifest } from '../../plugins/types'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceDialogHeader, { ToneTile } from './SourceDialogHeader'
import { buildSourceMenu, type SourceEntry, type SourceGroup, type SourceGroupId } from './sourceMenu'

interface TemplateSelectorProps {
  /** Creating a web scraper (`POST /scrapers`) is admin-only — owner decision
   *  (2026-10-08) — so the scraper templates are disabled for a non-admin, with
   *  the admin-only title and a note. Importing data is admin-only too (owner
   *  decision 2026-10-08, #242 follow-up: `/scrapers/manual/*` and `/s3-import/*`),
   *  so the manual-input tiles (paste, JSON, CSV) and the S3 import plugin tile are
   *  disabled the same way. App sources and synthetic data are unaffected. */
  readonly isAdmin: boolean
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

/** Web scraper templates: JSON-LD (structured data) vs hand-written CSS selectors. */
function templateIcon(template: ScraperTemplate): LucideIcon {
  return template.extraction_method === 'jsonld' ? FileJson : Code2
}

/**
 * One selectable source. Every tile has the same neutral surface and the same
 * `accent` icon tile; the KIND of source is carried by the icon and the text, never
 * by a tone (labels vs status, rule 15). It used to be five tinted fills and
 * borders, then five tile tones — both read as five different states.
 */
function SourceTile({ icon, title, description, onClick, disabledReason }: Readonly<{
  icon: LucideIcon
  title: string
  description?: string
  onClick: () => void
  /** When set, the tile is disabled and this is its `title` (why). */
  disabledReason?: string
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabledReason != null}
      title={disabledReason}
      className="group flex items-start gap-3 p-3 sm:p-4 rounded-lg border border-border bg-card text-left transition-colors hover:border-border-strong hover:bg-bg-hover focus-ring disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-card disabled:hover:border-border"
    >
      <ToneTile icon={icon} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-text-strong">{title}</span>
        </span>
        {description != null && description !== '' ? <span className="block text-xs text-muted mt-1">{description}</span> : null}
      </span>
      <Plus size={16} className="text-muted opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" aria-hidden="true" />
    </button>
  )
}

function TileSection({ title, note, children }: Readonly<{ title: string; note?: string; children: ReactNode }>) {
  return (
    <section>
      <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted mb-2">{title}</h3>
      {note == null ? null : <p className="text-xs text-muted mb-2">{note}</p>}
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

/** The icon an entry shows: its plugin's own, or the kind of thing it reads. */
function entryIcon(entry: SourceEntry): LucideIcon {
  const { action } = entry
  if (action.kind === 'plugin') return manifestIcon(action.plugin.icon, action.plugin.category)
  if (action.kind === 'template') return templateIcon(action.template)
  if (action.kind === 'generator') return FlaskConical
  return IMPORT_ICONS[action.kind]
}

const IMPORT_ICONS = { manual: ClipboardPaste, json: Upload, csv: FileText } as const

const GROUP_TITLE_KEYS: Readonly<Record<SourceGroupId, string>> = {
  website: 'sourceMenu.groups.website', app: 'sourceMenu.groups.app', file: 'sourceMenu.groups.file',
  paste: 'sourceMenu.groups.paste', tool: 'sourceMenu.groups.tool', advanced: 'sourceMenu.groups.advanced',
}

/** The admin-only note a group carries for a non-admin, when any of its entries are admin-only. */
function groupNote(group: SourceGroup, isAdmin: boolean, t: (key: string) => string): string | undefined {
  if (isAdmin || !group.entries.some((entry) => entry.adminOnly)) return undefined
  return group.id === 'website' || group.id === 'advanced' ? t('templateSelector.scrapersAdminOnly') : t('templateSelector.importsAdminOnly')
}

function EntryTile({ entry, isAdmin, onChoose }: Readonly<{ entry: SourceEntry; isAdmin: boolean; onChoose: (entry: SourceEntry) => void }>) {
  const { t } = useTranslation('scrapers')
  return (
    <SourceTile
      icon={entryIcon(entry)}
      title={entry.keys === undefined ? entry.fallbackTitle : t(entry.keys.title)}
      description={entry.keys === undefined ? entry.fallbackDescription : t(entry.keys.description)}
      onClick={() => onChoose(entry)}
      disabledReason={entry.adminOnly && !isAdmin ? ADMIN_ONLY_TITLE : undefined}
    />
  )
}

function MenuGroup({ group, isAdmin, onChoose }: Readonly<{ group: SourceGroup; isAdmin: boolean; onChoose: (entry: SourceEntry) => void }>) {
  const { t } = useTranslation('scrapers')
  const tiles = group.entries.map((entry) => <EntryTile key={entry.id} entry={entry} isAdmin={isAdmin} onChoose={onChoose} />)
  const note = groupNote(group, isAdmin, t)
  if (group.id !== 'advanced') return <TileSection title={t(GROUP_TITLE_KEYS[group.id])} note={note}>{tiles}</TileSection>
  // Technical options stay one click away, collapsed: hidden, never deleted.
  return (
    <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium text-text-strong focus-ring rounded-sm">{t(GROUP_TITLE_KEYS.advanced)}</summary>
      <div className="mt-3"><TileSection title={t('sourceMenu.advancedHint')} note={note}>{tiles}</TileSection></div>
    </details>
  )
}

export default function TemplateSelector({
  isAdmin, onSelect, onSelectPlugin, onSelectGenerator, onManualImport, onJsonUpload, onCsvUpload, onClose,
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

  const groups = buildSourceMenu(getDiscoverablePlugins(), mergeTemplates(data?.templates ?? []), getSyntheticPlugins())
  const importHandlers = { manual: onManualImport, json: onJsonUpload, csv: onCsvUpload }
  const choose = (entry: SourceEntry) => {
    const { action } = entry
    if (action.kind === 'plugin') onSelectPlugin(action.plugin)
    else if (action.kind === 'template') onSelect(action.template)
    else if (action.kind === 'generator') onSelectGenerator(action.plugin)
    else importHandlers[action.kind]()
  }

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-3xl max-h-[95vh] sm:max-h-[90vh]">
      <SourceDialogHeader titleId={titleId} title={t('templateSelector.title')} description={t('sourceMenu.prompt')} icon={Plus} onClose={onClose} />

      <div className="dialog-body space-y-5">
        {groups.map((group) => <MenuGroup key={group.id} group={group} isAdmin={isAdmin} onChoose={choose} />)}
      </div>

      <div className="dialog-footer">
        <button type="button" onClick={onClose} className="btn btn-secondary">{t('templateSelector.cancel')}</button>
      </div>
    </ModalShell>
  )
}
