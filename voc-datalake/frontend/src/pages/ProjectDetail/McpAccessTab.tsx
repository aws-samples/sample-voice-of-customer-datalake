/**
 * McpAccessTab - MCP tokens, config, and Kiro autoseed.
 *
 * Layout redesign:
 *  1. Header + "Generate Token" button
 *  2. Newly-created token banner (masked by default, never embedded in snippets)
 *  3. MCP config snippet (always uses placeholder — never the real token)
 *  4. Collapsible token list (shows count, expands on click)
 *  5. Kiro Autoseed card
 *
 * Security: the raw token value is only ever shown inside the masked
 * banner and copied to clipboard. It is never rendered into the mcp.json
 * snippet or the autoseed curl command.
 */
import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Key, Plus, Trash2, Copy, Check, Eye, EyeOff,
  Clock, Shield, AlertCircle, ChevronDown, ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import type { ApiToken, ProjectPersona, ProjectDocument } from '../../api/types'
import AutoseedCard from './AutoseedCard'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface McpAccessTabProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function McpAccessTab({ projectId, personas, documents }: McpAccessTabProps) {
  const { config } = useConfigStore()
  const queryClient = useQueryClient()

  // Token creation form
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [tokenName, setTokenName] = useState('')
  const [tokenScope, setTokenScope] = useState<'read' | 'read-write'>('read')

  // Newly created token (shown once, never embedded elsewhere)
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)

  // Clipboard feedback
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Collapsible token list
  const [tokensExpanded, setTokensExpanded] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['api-tokens', projectId],
    queryFn: () => api.listApiTokens(projectId),
    enabled: !!config.apiEndpoint,
    retry: false,
  })

  const createMut = useMutation({
    mutationFn: () => api.createApiToken(projectId, { name: tokenName, scope: tokenScope }),
    onSuccess: (result) => {
      setNewlyCreatedToken(result.token)
      setShowCreateForm(false)
      setTokenName('')
      setTokenScope('read')
      setShowToken(false)
      queryClient.invalidateQueries({ queryKey: ['api-tokens', projectId] })
    },
  })

  const deleteMut = useMutation({
    mutationFn: (tokenId: string) => api.deleteApiToken(projectId, tokenId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-tokens', projectId] }),
  })

  const copyToClipboard = useCallback(async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }, [])

  const baseUrl = (config.apiEndpoint || 'https://<api-gateway-url>').replace(/\/$/, '')
  const tokens = data?.tokens ?? []

  // Config snippet always uses a placeholder — never the real token
  const mcpConfig = buildMcpConfig(baseUrl, projectId)

  if (isError) {
    return (
      <div className="space-y-6">
        <McpAccessErrorState />
        <AutoseedCard projectId={projectId} personas={personas} documents={documents} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Key size={20} className="text-indigo-600" />
            MCP Access
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            Generate API tokens to connect this project to MCP-compatible clients like Kiro or VS Code.
          </p>
        </div>
        {!showCreateForm && !newlyCreatedToken && (
          <button
            onClick={() => setShowCreateForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm"
          >
            <Plus size={16} />
            Generate Token
          </button>
        )}
      </div>

      {/* ---- Newly created token (masked by default) ---- */}
      {newlyCreatedToken && (
        <NewTokenBanner
          token={newlyCreatedToken}
          showToken={showToken}
          copiedId={copiedId}
          onToggleShow={() => setShowToken(prev => !prev)}
          onCopy={() => copyToClipboard(newlyCreatedToken, 'new-token')}
          onDismiss={() => { setNewlyCreatedToken(null); setShowToken(false) }}
        />
      )}

      {/* ---- Create token form ---- */}
      {showCreateForm && (
        <CreateTokenForm
          tokenName={tokenName}
          tokenScope={tokenScope}
          isCreating={createMut.isPending}
          error={createMut.error?.message}
          onNameChange={setTokenName}
          onScopeChange={setTokenScope}
          onSubmit={() => createMut.mutate()}
          onCancel={() => { setShowCreateForm(false); setTokenName(''); createMut.reset() }}
        />
      )}

      {/* ---- MCP config snippet (placeholder token) ---- */}
      <McpConfigSnippet
        config={mcpConfig}
        copied={copiedId === 'mcp-config'}
        onCopy={() => copyToClipboard(mcpConfig, 'mcp-config')}
      />

      {/* ---- Collapsible token list ---- */}
      <TokenListCollapsible
        tokens={tokens}
        isLoading={isLoading}
        expanded={tokensExpanded}
        onToggle={() => setTokensExpanded(prev => !prev)}
        deletingTokenId={deleteMut.isPending ? (deleteMut.variables ?? null) : null}
        onDelete={(tokenId) => deleteMut.mutate(tokenId)}
      />

      {/* ---- Kiro Autoseed ---- */}
      <AutoseedCard projectId={projectId} personas={personas} documents={documents} />
    </div>
  )
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
// Error state
// ---------------------------------------------------------------------------

function McpAccessErrorState() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Key size={20} className="text-indigo-600" />
            MCP Access
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            Generate API tokens to connect this project to MCP-compatible clients like Kiro or VS Code.
          </p>
        </div>
      </div>
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
        <AlertCircle size={32} className="mx-auto text-amber-400 mb-3" />
        <p className="text-amber-800 font-medium">MCP Access is not available yet</p>
        <p className="text-amber-600 text-sm mt-1">
          The API token management endpoint has not been deployed. Deploy the backend with MCP token support to enable this feature.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// New token banner — masked by default, copy-only
// ---------------------------------------------------------------------------

interface NewTokenBannerProps {
  readonly token: string
  readonly showToken: boolean
  readonly copiedId: string | null
  readonly onToggleShow: () => void
  readonly onCopy: () => void
  readonly onDismiss: () => void
}

function NewTokenBanner({ token, showToken, copiedId, onToggleShow, onCopy, onDismiss }: NewTokenBannerProps) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
      <div className="flex items-start gap-3">
        <Check size={20} className="text-green-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-green-800">Token created successfully</p>
          <p className="text-sm text-green-700 mt-1">
            Copy this token now — it won't be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 bg-white border border-green-300 rounded px-3 py-2 text-sm font-mono break-all select-none">
              {showToken ? token : '•'.repeat(Math.min(token.length, 40))}
            </code>
            <button
              onClick={onToggleShow}
              className="p-2 text-green-700 hover:bg-green-100 rounded"
              title={showToken ? 'Hide token' : 'Reveal token'}
            >
              {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button
              onClick={onCopy}
              className="p-2 text-green-700 hover:bg-green-100 rounded"
              title="Copy token to clipboard"
            >
              {copiedId === 'new-token' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <p className="text-xs text-green-600 mt-2">
            Paste this token into the <code className="bg-green-100 px-1 rounded">Authorization</code> header of your mcp.json or autoseed curl command.
          </p>
        </div>
        <button onClick={onDismiss} className="text-green-600 hover:text-green-800 text-sm font-medium">
          Dismiss
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Create token form
// ---------------------------------------------------------------------------

interface CreateTokenFormProps {
  readonly tokenName: string
  readonly tokenScope: 'read' | 'read-write'
  readonly isCreating: boolean
  readonly error?: string
  readonly onNameChange: (name: string) => void
  readonly onScopeChange: (scope: 'read' | 'read-write') => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
}

function CreateTokenForm({ tokenName, tokenScope, isCreating, error, onNameChange, onScopeChange, onSubmit, onCancel }: CreateTokenFormProps) {
  return (
    <div className="bg-white border rounded-lg p-4">
      <h4 className="font-medium mb-3">Generate new API token</h4>
      <div className="space-y-3">
        <div>
          <label htmlFor="token-name" className="block text-sm font-medium text-gray-700 mb-1">Token name</label>
          <input
            id="token-name"
            type="text"
            value={tokenName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g. My Kiro token"
            className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>
        <div>
          <label htmlFor="token-scope" className="block text-sm font-medium text-gray-700 mb-1">Scope</label>
          <select
            id="token-scope"
            value={tokenScope}
            onChange={(e) => {
              const val = e.target.value
              if (val === 'read' || val === 'read-write') onScopeChange(val)
            }}
            className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          >
            <option value="read">Read only — search feedback, view metrics</option>
            <option value="read-write">Read & write — includes chat and document generation</option>
          </select>
        </div>
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertCircle size={14} />
            {error}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!tokenName.trim() || isCreating}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? 'Generating...' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP config snippet (always placeholder token)
// ---------------------------------------------------------------------------

interface McpConfigSnippetProps {
  readonly config: string
  readonly copied: boolean
  readonly onCopy: () => void
}

function McpConfigSnippet({ config, copied, onCopy }: McpConfigSnippetProps) {
  return (
    <div className="bg-white border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-medium text-sm">MCP Client Configuration</h4>
        <button
          onClick={onCopy}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100"
        >
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-2">
        Add this to your <code className="bg-gray-100 px-1 rounded">mcp.json</code>. Replace <code className="bg-gray-100 px-1 rounded">&lt;YOUR_API_TOKEN&gt;</code> with a token from below.
      </p>
      <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-x-auto">
        <code>{config}</code>
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible token list
// ---------------------------------------------------------------------------

interface TokenListCollapsibleProps {
  readonly tokens: ApiToken[]
  readonly isLoading: boolean
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly deletingTokenId: string | null
  readonly onDelete: (tokenId: string) => void
}

function TokenListCollapsible({ tokens, isLoading, expanded, onToggle, deletingTokenId, onDelete }: TokenListCollapsibleProps) {
  if (isLoading) {
    return (
      <div className="bg-white border rounded-lg p-6 text-center text-gray-500 text-sm">
        Loading tokens…
      </div>
    )
  }

  if (tokens.length === 0) {
    return (
      <div className="bg-white border rounded-lg p-6 text-center">
        <Key size={28} className="mx-auto text-gray-300 mb-2" />
        <p className="text-gray-500 text-sm">No API tokens yet</p>
        <p className="text-gray-400 text-xs mt-1">Generate a token to connect MCP clients to this project.</p>
      </div>
    )
  }

  return (
    <div className="bg-white border rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 rounded-lg text-left"
      >
        <h4 className="font-medium text-sm text-gray-700 flex items-center gap-2">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Active Tokens ({tokens.length})
        </h4>
        <span className="text-xs text-gray-400">
          {expanded ? 'Collapse' : 'Expand'}
        </span>
      </button>
      {expanded && (
        <div className="divide-y border-t">
          {tokens.map((token) => (
            <TokenRow
              key={token.token_id}
              token={token}
              isDeleting={deletingTokenId === token.token_id}
              onDelete={() => onDelete(token.token_id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Token row
// ---------------------------------------------------------------------------

interface TokenRowProps {
  readonly token: ApiToken
  readonly isDeleting: boolean
  readonly onDelete: () => void
}

function TokenRow({ token, isDeleting, onDelete }: TokenRowProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <Key size={16} className="text-gray-400 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{token.name}</p>
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
            <span className={clsx(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium',
              token.scope === 'read' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
            )}>
              <Shield size={10} />
              {token.scope}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              Created {new Date(token.created_at).toLocaleDateString()}
            </span>
            {token.last_used_at && (
              <span className="text-gray-400">
                Last used {new Date(token.last_used_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>
      <button
        onClick={onDelete}
        disabled={isDeleting}
        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
        title="Revoke token"
      >
        <Trash2 size={16} />
      </button>
    </div>
  )
}
