/**
 * McpAccessTab - "Export / MCP" tab.
 *
 * Organised by setup cost:
 *
 *  Card 1 — "Export" (no API token needed)
 *    • Persona / document picker (shared with Card 2 for the curl URL)
 *    • Kiro export-prompt template editor (KiroExportSettings)
 *    • Copy-to-clipboard button → GET /projects/{id}/autoseed (Cognito-session auth)
 *
 *  Card 2 — "MCP Access" (API token required)
 *    • Generate token / active tokens
 *    • mcp.json snippet
 *    • Kiro Autoseed curl prompt (uses the shared selection to build the URL)
 *
 * The picker state (selectedPersonaIds, selectedDocumentIds) is held at tab
 * level so both cards see the same selection without duplicating the UI.
 */
import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import {
  Key, Plus, Copy, Check, Download,
} from 'lucide-react'
import {
  useState, useCallback, useMemo, useId,
} from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { stripTrailingSlashes } from '../../api/baseUrl'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { useConfigStore } from '../../store/configStore'
import { buildAutoseedParams, canCopyExport } from './autoseedSelection'
import AutoseedContent from './AutoseedContent'
import CollapsibleSection from './CollapsibleSection'
import KiroExportSettings from './KiroExportSettings'
import {
  McpAccessErrorState,
  NewTokenBanner,
  CreateTokenForm,
  McpConfigSnippetContent,
  TokenListContent,
} from './McpAccessComponents'
import {
  PickerSection, CheckboxItem,
} from './PickerComponents'
import type {
  ProjectPersona, ProjectDocument, Project,
} from '../../api/types'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface McpAccessTabProps {
  readonly projectId: string
  readonly project: Project
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly onSaveKiroPrompt: (prompt: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Always uses a placeholder — the real token is never embedded. */
function buildMcpConfig(baseUrl: string, projectId: string): string {
  return JSON.stringify({
    mcpServers: {
      'voc-datalake': {
        url: `${baseUrl}/mcp`,
        headers: {
          Authorization: 'Bearer <YOUR_API_TOKEN>',
          'X-Project-Id': projectId,
        },
      },
    },
  }, null, 2)
}

/**
 * Side by side from `lg` up, stacked below. Named because both return paths
 * (normal and token-error) must lay out identically, and takes EXACTLY two
 * children — the token-error path wraps its two for that reason.
 *
 * `items-start` keeps the shorter card at its own height. Grid children need
 * `min-w-0`: they default to `min-width: auto`, so the curl snippet's long
 * unbroken URL would otherwise push its track past the even split.
 */
const TWO_COLUMN_LAYOUT = 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start'

type DocType = 'prd' | 'prfaq' | 'research' | 'custom'

function isValidDocType(value: string): value is DocType {
  return value === 'prd' || value === 'prfaq' || value === 'research' || value === 'custom'
}

function groupDocumentsByType(documents: ProjectDocument[]): Record<DocType, ProjectDocument[]> {
  const groups: Record<DocType, ProjectDocument[]> = {
    prd: [],
    prfaq: [],
    research: [],
    custom: [],
  }
  for (const doc of documents) {
    const docType = isValidDocType(doc.document_type) ? doc.document_type : 'custom'
    groups[docType].push(doc)
  }
  return groups
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useTokenMutations(projectId: string, tokenName: string, tokenScope: 'read' | 'read-write', onCreateSuccess: () => void) {
  const queryClient = useQueryClient()
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)

  const createMut = useMutation({
    mutationFn: () => api.createApiToken(projectId, {
      name: tokenName,
      scope: tokenScope,
    }),
    onSuccess: (result) => {
      setNewlyCreatedToken(result.token)
      setShowCreateForm(false)
      setShowToken(false)
      onCreateSuccess()
      void queryClient.invalidateQueries({ queryKey: ['api-tokens', projectId] })
    },
  })

  const deleteMut = useMutation({
    mutationFn: (tokenId: string) => api.deleteApiToken(projectId, tokenId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-tokens', projectId] })
    },
  })

  return {
    createMut,
    deleteMut,
    newlyCreatedToken,
    setNewlyCreatedToken,
    showToken,
    setShowToken,
    showCreateForm,
    setShowCreateForm,
  }
}

// ---------------------------------------------------------------------------
// Picker sub-components (shared between the two cards)
// ---------------------------------------------------------------------------

interface SharedPickerProps {
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly selectedPersonaIds: ReadonlySet<string>
  readonly selectedDocumentIds: ReadonlySet<string>
  readonly expandedSections: ReadonlySet<string>
  readonly onTogglePersona: (id: string) => void
  readonly onToggleDocument: (id: string) => void
  readonly onToggleAllPersonas: (select: boolean) => void
  readonly onToggleAllDocuments: (select: boolean) => void
  readonly onToggleSection: (section: string) => void
}

function SharedPickers({
  personas,
  documents,
  selectedPersonaIds,
  selectedDocumentIds,
  expandedSections,
  onTogglePersona,
  onToggleDocument,
  onToggleAllPersonas,
  onToggleAllDocuments,
  onToggleSection,
}: SharedPickerProps) {
  const { t } = useTranslation('projectDetail')
  const docGroups = useMemo(() => groupDocumentsByType(documents), [documents])

  if (personas.length === 0 && documents.length === 0) return null

  return (
    <div className="mb-4">
      {personas.length > 0 && (
        <PickerSection
          title={t('autoseed.personas', {
            selected: selectedPersonaIds.size,
            total: personas.length,
          })}
          expanded={expandedSections.has('personas')}
          onToggle={() => onToggleSection('personas')}
          allSelected={selectedPersonaIds.size === personas.length}
          onToggleAll={onToggleAllPersonas}
        >
          {personas.map((p) => (
            <CheckboxItem
              key={p.persona_id}
              id={p.persona_id}
              label={p.name}
              sublabel={p.tagline}
              checked={selectedPersonaIds.has(p.persona_id)}
              onChange={() => onTogglePersona(p.persona_id)}
            />
          ))}
        </PickerSection>
      )}
      {documents.length > 0 && (
        <PickerSection
          title={t('autoseed.documents', {
            selected: selectedDocumentIds.size,
            total: documents.length,
          })}
          expanded={expandedSections.has('documents')}
          onToggle={() => onToggleSection('documents')}
          allSelected={selectedDocumentIds.size === documents.length}
          onToggleAll={onToggleAllDocuments}
        >
          {Object.keys(docGroups)
            .filter(isValidDocType)
            .filter((type) => docGroups[type].length > 0)
            .map((type) => {
              const docs = docGroups[type]
              return (
                <div key={type} className="mb-2">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{t(`autoseed.docTypes.${type}`)}</p>
                  {docs.map((d) => (
                    <CheckboxItem
                      key={d.document_id}
                      id={d.document_id}
                      label={d.title}
                      sublabel={d.document_type}
                      checked={selectedDocumentIds.has(d.document_id)}
                      onChange={() => onToggleDocument(d.document_id)}
                    />
                  ))}
                </div>
              )
            })}
        </PickerSection>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card 1 — Export (no API token required)
// ---------------------------------------------------------------------------

interface ExportCardProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  readonly selectedPersonaIds: ReadonlySet<string>
  readonly selectedDocumentIds: ReadonlySet<string>
  readonly expandedSections: ReadonlySet<string>
  readonly onTogglePersona: (id: string) => void
  readonly onToggleDocument: (id: string) => void
  readonly onToggleAllPersonas: (select: boolean) => void
  readonly onToggleAllDocuments: (select: boolean) => void
  readonly onToggleSection: (section: string) => void
  /**
   * The export-prompt template editor, rendered as a section inside this card.
   * A slot rather than a `project` prop so ExportCard stays presentational and
   * needs no knowledge of the template — same idiom as ActionCard's `statusLine`.
   */
  readonly templateEditor: ReactNode
}

function ExportCard({
  projectId,
  personas,
  documents,
  selectedPersonaIds,
  selectedDocumentIds,
  expandedSections,
  onTogglePersona,
  onToggleDocument,
  onToggleAllPersonas,
  onToggleAllDocuments,
  onToggleSection,
  templateEditor,
}: ExportCardProps) {
  const { t } = useTranslation('projectDetail')
  const blockedReasonId = useId()
  // markCopied, not copy: handleCopy awaits its own writeText so a rejection can
  // be surfaced, and copy() would write a second time and swallow that failure.
  const { markCopied, copiedKey } = useCopyToClipboard()
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const isEmpty = personas.length === 0 && documents.length === 0
  const canCopy = canCopyExport(
    selectedPersonaIds, personas.length, selectedDocumentIds, documents.length,
  )

  const handleCopy = useCallback(async () => {
    // Second of two layers. The disabled button is the user-facing authority;
    // this one makes the invariant hold even if a future caller invokes the
    // handler directly, because exporting in that state silently includes
    // deselected items rather than failing visibly.
    if (!canCopyExport(selectedPersonaIds, personas.length, selectedDocumentIds, documents.length)) {
      return
    }
    setCopying(true)
    setCopyError(null)
    try {
      const payload = await api.autoseedProject(
        projectId,
        buildAutoseedParams(selectedPersonaIds, personas.length, selectedDocumentIds, documents.length),
      )

      // Concatenate all file contents into a single clipboard payload.
      // The backend already bakes kiro_export_prompt into the steering file
      // via _build_steering_file, so we do NOT add it here — that would
      // duplicate it and diverge from the autoseed format.
      const text = payload.files.map((f) => `${f.content}`).join('\n\n')
      await navigator.clipboard.writeText(text)
      markCopied('export')
    } catch (err) {
      console.error('[ExportCard] autoseed copy failed:', err)
      setCopyError(t('export.copyFailed'))
    } finally {
      setCopying(false)
    }
  }, [projectId, selectedPersonaIds, selectedDocumentIds, personas.length, documents.length, markCopied, t])

  return (
    // min-w-0: this is a grid child in TWO_COLUMN_LAYOUT.
    <div className="bg-white rounded-xl p-6 border min-w-0">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center flex-shrink-0">
          <Download size={20} className="text-green-600" />
        </div>
        <div>
          <h3 className="font-semibold">{t('export.title')}</h3>
          <p className="text-sm text-gray-500">{t('export.description')}</p>
        </div>
      </div>

      {isEmpty ? (
        <p className="text-sm text-gray-400 text-center py-4">{t('export.emptyHint')}</p>
      ) : (
        <>
          {/* Shared pickers */}
          <SharedPickers
            personas={personas}
            documents={documents}
            selectedPersonaIds={selectedPersonaIds}
            selectedDocumentIds={selectedDocumentIds}
            expandedSections={expandedSections}
            onTogglePersona={onTogglePersona}
            onToggleDocument={onToggleDocument}
            onToggleAllPersonas={onToggleAllPersonas}
            onToggleAllDocuments={onToggleAllDocuments}
            onToggleSection={onToggleSection}
          />

          {/* Copy button */}
          <div className="mt-4 flex flex-col items-end gap-2">
            <button
              onClick={() => void handleCopy()}
              disabled={!canCopy || copying}
              // Associated so the reason is announced with the control rather
              // than being visual-only; useId, not a constant, because a page can
              // render more than one project surface.
              aria-describedby={canCopy ? undefined : blockedReasonId}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              {copiedKey === 'export' ? <Check size={16} /> : <Copy size={16} />}
              {copiedKey === 'export' ? t('export.copyCopied') : t('export.copyContext')}
            </button>
            {/* Says WHY it is disabled. Without this the button just looks broken
                when a section has items but none of them are selected. */}
            {!canCopy && (
              <p id={blockedReasonId} className="text-sm text-gray-500">
                {t('export.selectAtLeastOne')}
              </p>
            )}
            {copyError != null && (
              <p className="text-sm text-red-600" role="alert">{copyError}</p>
            )}
          </div>
        </>
      )}
      {/* Template editor sits OUTSIDE the isEmpty branch on purpose: the prompt
          is configurable before any personas or documents exist, and it also
          feeds Card 2's autoseed payload, so hiding it on an empty project
          would strand the only editor for it. */}
      <div className="mt-6 pt-6 border-t">
        {templateEditor}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP Access header sub-component
// ---------------------------------------------------------------------------

function McpHeader({
  showCreateForm,
  newlyCreatedToken,
  onShowCreate,
}: Readonly<{
  showCreateForm: boolean
  newlyCreatedToken: string | null
  onShowCreate: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const showButton = !showCreateForm && (newlyCreatedToken == null || newlyCreatedToken === '')
  return (
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Key size={20} className="text-indigo-600" />
          {t('mcp.title')}
        </h3>
        <p className="text-sm text-gray-500 mt-1">{t('mcp.description')}</p>
      </div>
      {showButton ? (
        <button onClick={onShowCreate} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm">
          <Plus size={16} />{t('mcp.generateToken')}
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function McpAccessTab({
  projectId, project, personas, documents, onSaveKiroPrompt,
}: McpAccessTabProps) {
  const { config } = useConfigStore()
  const { t } = useTranslation('projectDetail')

  // ── Shared picker state (used by both cards) ──────────────────────────────
  //
  // DESELECTED ids are stored, and the selection is DERIVED from the props. The
  // obvious shape — `useState(() => new Set(personas.map(...)))` — initialises
  // once, so a tab that mounts while `personas`/`documents` are still loading
  // renders every row unchecked and never resyncs. Deriving removes that bug
  // class outright rather than syncing state to props in an effect, which this
  // repo's `set-state-in-effect` lint rule forbids anyway.
  //
  // "Everything is selected" is therefore the default and stays true for items
  // that arrive after mount.
  const [deselectedPersonaIds, setDeselectedPersonaIds] = useState<Set<string>>(() => new Set())
  const [deselectedDocumentIds, setDeselectedDocumentIds] = useState<Set<string>>(() => new Set())
  // Collapsed by default. Each section's header already states its selection as
  // "Personas (3/4)" and carries the Select all / Deselect all control, so the
  // count — the thing a user needs before copying — is visible without the rows.
  // Expanding is for changing the selection, not for reading it.
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(),
  )

  const selectedPersonaIds = useMemo(
    () => new Set(personas.map((p) => p.persona_id).filter((id) => !deselectedPersonaIds.has(id))),
    [personas, deselectedPersonaIds],
  )
  const selectedDocumentIds = useMemo(
    () => new Set(documents.map((d) => d.document_id).filter((id) => !deselectedDocumentIds.has(id))),
    [documents, deselectedDocumentIds],
  )

  // Toggling a row flips its membership in the DESELECTED set, so the checkbox
  // still reads as "selected" while the stored state is the complement.
  const togglePersona = useCallback((id: string) => {
    setDeselectedPersonaIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleDocument = useCallback((id: string) => {
    setDeselectedDocumentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAllPersonas = useCallback((select: boolean) => {
    setDeselectedPersonaIds(select ? new Set() : new Set(personas.map((p) => p.persona_id)))
  }, [personas])

  const toggleAllDocuments = useCallback((select: boolean) => {
    setDeselectedDocumentIds(select ? new Set() : new Set(documents.map((d) => d.document_id)))
  }, [documents])

  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }, [])

  // ── MCP token state ───────────────────────────────────────────────────────
  const [tokenName, setTokenName] = useState('')
  const [tokenScope, setTokenScope] = useState<'read' | 'read-write'>('read')
  const {
    copy, copiedKey: copiedId,
  } = useCopyToClipboard()

  // All three collapsible sections start collapsed
  const [tokensExpanded, setTokensExpanded] = useState(false)
  const [configExpanded, setConfigExpanded] = useState(false)
  const [autoseedExpanded, setAutoseedExpanded] = useState(false)

  const {
    createMut, deleteMut, newlyCreatedToken, setNewlyCreatedToken,
    showToken, setShowToken, showCreateForm, setShowCreateForm,
  } = useTokenMutations(projectId, tokenName, tokenScope, () => {
    setTokenName('')
    setTokenScope('read')
  })

  const {
    data, isLoading, isError,
  } = useQuery({
    queryKey: ['api-tokens', projectId],
    queryFn: () => api.listApiTokens(projectId),
    enabled: config.apiEndpoint.length > 0,
    retry: false,
  })

  const copyToClipboard = (text: string, id: string) => copy(text, id)

  const baseUrl = (config.apiEndpoint === '' ? 'https://<api-gateway-url>' : config.apiEndpoint).replace(/\/$/, '')
  const tokens = data?.tokens ?? []
  const mcpConfig = buildMcpConfig(baseUrl, projectId)

  // Whether the user has at least one persona or document selected
  // The SAME rule as the Export card, not an OR over the two sections: the curl
  // URL is built by the same buildAutoseedParams, so a section with items and
  // none selected would emit a curl that omits the filter and makes Kiro fetch
  // everything the user deselected. Both delivery paths share one guard.
  const hasPickerSelection = canCopyExport(
    selectedPersonaIds, personas.length, selectedDocumentIds, documents.length,
  )

  // Build the autoseed curl URL from shared selection (used by Card 2)
  const apiBase = stripTrailingSlashes(config.apiEndpoint === '' ? '' : config.apiEndpoint)
  const autoseedCurlUrl = useMemo(() => {
    const { personaIds, documentIds } = buildAutoseedParams(
      selectedPersonaIds, personas.length, selectedDocumentIds, documents.length,
    )
    const params = new URLSearchParams()
    if (personaIds != null) params.set('persona_ids', personaIds.join(','))
    if (documentIds != null) params.set('document_ids', documentIds.join(','))
    const qs = params.toString()
    const base = `${apiBase}/mcp/autoseed/${projectId}`
    return qs === '' ? base : `${base}?${qs}`
  }, [apiBase, projectId, selectedPersonaIds, selectedDocumentIds, personas.length, documents.length])

  // ── Card 1 — Export ───────────────────────────────────────────────────────
  const exportCard = (
    <ExportCard
      projectId={projectId}
      personas={personas}
      documents={documents}
      selectedPersonaIds={selectedPersonaIds}
      selectedDocumentIds={selectedDocumentIds}
      expandedSections={expandedSections}
      onTogglePersona={togglePersona}
      onToggleDocument={toggleDocument}
      onToggleAllPersonas={toggleAllPersonas}
      onToggleAllDocuments={toggleAllDocuments}
      onToggleSection={toggleSection}
      // Nested as a section inside the Export card rather than rendered as a
      // third sibling card: the template belongs to the token-free export path,
      // and a separate card split that grouping in two.
      templateEditor={<KiroExportSettings project={project} onSave={onSaveKiroPrompt} />}
    />
  )

  // ── Card 2 — MCP Access (error branch) ───────────────────────────────────
  if (isError) {
    return (
      <div className={TWO_COLUMN_LAYOUT}>
        {exportCard}
        {/* Wrapped so the grid still has exactly two children: the error state
            and the autoseed section together are the MCP column. */}
        <div className="space-y-4 min-w-0">
          <McpAccessErrorState />
          <CollapsibleSection
            title={t('autoseed.title')}
            expanded={autoseedExpanded}
            onToggle={() => setAutoseedExpanded((prev) => !prev)}
          >
            <AutoseedContent
              personas={personas}
              documents={documents}
              curlUrl={autoseedCurlUrl}
              hasSelection={hasPickerSelection}
            />
          </CollapsibleSection>
        </div>
      </div>
    )
  }

  // ── Card 2 — MCP Access (normal branch) ──────────────────────────────────
  return (
    <div className={TWO_COLUMN_LAYOUT}>
      {/* Card 1 — Export (no API token); the template editor is a section inside it */}
      {exportCard}

      {/* Card 2 — MCP Access (API token required) */}
      <div className="bg-white rounded-xl p-6 border space-y-4 min-w-0">
        <McpHeader
          showCreateForm={showCreateForm}
          newlyCreatedToken={newlyCreatedToken}
          onShowCreate={() => setShowCreateForm(true)}
        />

        {newlyCreatedToken != null && newlyCreatedToken !== '' ? <NewTokenBanner
          token={newlyCreatedToken}
          showToken={showToken}
          copiedId={copiedId}
          onToggleShow={() => setShowToken((prev) => !prev)}
          onCopy={() => {
            copyToClipboard(newlyCreatedToken, 'new-token')
          }}
          onDismiss={() => {
            setNewlyCreatedToken(null); setShowToken(false)
          }}
        /> : null}

        {showCreateForm ? <CreateTokenForm
          tokenName={tokenName}
          tokenScope={tokenScope}
          isCreating={createMut.isPending}
          error={createMut.error?.message}
          onNameChange={setTokenName}
          onScopeChange={setTokenScope}
          onSubmit={() => createMut.mutate()}
          onCancel={() => {
            setShowCreateForm(false); setTokenName(''); createMut.reset()
          }}
        /> : null}

        {/* 1. Active Tokens */}
        <CollapsibleSection
          title={t('mcp.activeTokens', { count: tokens.length })}
          expanded={tokensExpanded}
          onToggle={() => setTokensExpanded((prev) => !prev)}
        >
          <TokenListContent
            tokens={tokens}
            isLoading={isLoading}
            deletingTokenId={deleteMut.isPending ? deleteMut.variables : null}
            onDelete={(tokenId) => deleteMut.mutate(tokenId)}
          />
        </CollapsibleSection>

        {/* 2. MCP Client Configuration */}
        <CollapsibleSection
          title={t('mcp.mcpConfig')}
          expanded={configExpanded}
          onToggle={() => setConfigExpanded((prev) => !prev)}
        >
          <McpConfigSnippetContent
            config={mcpConfig}
            copied={copiedId === 'mcp-config'}
            onCopy={() => {
              copyToClipboard(mcpConfig, 'mcp-config')
            }}
          />
        </CollapsibleSection>

        {/* 3. Kiro Autoseed (curl prompt — URL built from shared selection) */}
        <CollapsibleSection
          title={t('autoseed.title')}
          expanded={autoseedExpanded}
          onToggle={() => setAutoseedExpanded((prev) => !prev)}
        >
          <AutoseedContent
            personas={personas}
            documents={documents}
            curlUrl={autoseedCurlUrl}
            hasSelection={hasPickerSelection}
          />
        </CollapsibleSection>
      </div>
    </div>
  )
}
