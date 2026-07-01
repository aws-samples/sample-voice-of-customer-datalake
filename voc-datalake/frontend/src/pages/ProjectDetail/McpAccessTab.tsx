/**
 * McpAccessTab - MCP tokens, config, and Kiro autoseed.
 *
 * Layout: Header + Generate Token → three collapsible sections:
 *   1. Active Tokens
 *   2. MCP Client Configuration
 *   3. Kiro Autoseed
 *
 * Security: the raw token value is only ever shown inside the masked
 * banner and copied to clipboard. It is never rendered into the mcp.json
 * snippet or the autoseed curl command.
 */
import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import {
  Key, Plus,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { useConfigStore } from '../../store/configStore'
import AutoseedContent from './AutoseedContent'
import CollapsibleSection from './CollapsibleSection'
import {
  McpAccessErrorState,
  NewTokenBanner,
  CreateTokenForm,
  McpConfigSnippetContent,
  TokenListContent,
} from './McpAccessComponents'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface McpAccessTabProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
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
// Sub-components
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
  projectId, personas, documents,
}: McpAccessTabProps) {
  const { config } = useConfigStore()
  const { t } = useTranslation('projectDetail')

  const [tokenName, setTokenName] = useState('')
  const [tokenScope, setTokenScope] = useState<'read' | 'read-write'>('read')
  const {
    copy, copiedKey: copiedId,
  } = useCopyToClipboard()

  // All three sections start collapsed
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

  if (isError) {
    return (
      <div className="space-y-4">
        <McpAccessErrorState />
        <CollapsibleSection
          title={t('autoseed.title')}
          expanded={autoseedExpanded}
          onToggle={() => setAutoseedExpanded((prev) => !prev)}
        >
          <AutoseedContent projectId={projectId} personas={personas} documents={documents} />
        </CollapsibleSection>
      </div>
    )
  }

  return (
    <div className="space-y-4">
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

      {/* 3. Kiro Autoseed */}
      <CollapsibleSection
        title={t('autoseed.title')}
        expanded={autoseedExpanded}
        onToggle={() => setAutoseedExpanded((prev) => !prev)}
      >
        <AutoseedContent projectId={projectId} personas={personas} documents={documents} />
      </CollapsibleSection>
    </div>
  )
}
