/**
 * Sub-components for McpAccessTab, extracted to keep file under max-lines limit.
 */
import clsx from 'clsx'
import {
  Key, Trash2, Copy, Check, Eye, EyeOff,
  Clock, Shield, AlertCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ApiToken } from '../../api/types'

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

export function McpAccessErrorState() {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Key size={20} className="text-indigo-600" />
            {t('mcp.title')}
          </h3>
          <p className="text-sm text-gray-500 mt-1">{t('mcp.description')}</p>
        </div>
      </div>
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
        <AlertCircle size={32} className="mx-auto text-amber-400 mb-3" />
        <p className="text-amber-800 font-medium">{t('mcp.notAvailable')}</p>
        <p className="text-amber-600 text-sm mt-1">{t('mcp.notAvailableDesc')}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// New token banner
// ---------------------------------------------------------------------------

interface NewTokenBannerProps {
  readonly token: string
  readonly showToken: boolean
  readonly copiedId: string | null
  readonly onToggleShow: () => void
  readonly onCopy: () => void
  readonly onDismiss: () => void
}

export function NewTokenBanner({
  token, showToken, copiedId, onToggleShow, onCopy, onDismiss,
}: NewTokenBannerProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
      <div className="flex items-start gap-3">
        <Check size={20} className="text-green-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-green-800">{t('mcp.tokenCreated')}</p>
          <p className="text-sm text-green-700 mt-1">{t('mcp.copyTokenNow')}</p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 bg-white border border-green-300 rounded px-3 py-2 text-sm font-mono break-all select-none">
              {showToken ? token : '•'.repeat(Math.min(token.length, 40))}
            </code>
            <button onClick={onToggleShow} className="p-2 text-green-700 hover:bg-green-100 rounded" title={showToken ? t('mcp.hideToken') : t('mcp.revealToken')}>
              {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button onClick={onCopy} className="p-2 text-green-700 hover:bg-green-100 rounded" title={t('mcp.copyToken')}>
              {copiedId === 'new-token' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <p className="text-xs text-green-600 mt-2">{t('mcp.tokenPasteHint')}</p>
        </div>
        <button onClick={onDismiss} className="text-green-600 hover:text-green-800 text-sm font-medium">{t('mcp.dismiss')}</button>
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

export function CreateTokenForm({
  tokenName, tokenScope, isCreating, error, onNameChange, onScopeChange, onSubmit, onCancel,
}: CreateTokenFormProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="bg-white border rounded-lg p-4">
      <h4 className="font-medium mb-3">{t('mcp.generateNewToken')}</h4>
      <div className="space-y-3">
        <div>
          <label htmlFor="token-name" className="block text-sm font-medium text-gray-700 mb-1">{t('mcp.tokenName')}</label>
          <input id="token-name" type="text" value={tokenName} onChange={(e) => onNameChange(e.target.value)} placeholder={t('mcp.tokenNamePlaceholder')} className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" />
        </div>
        <div>
          <label htmlFor="token-scope" className="block text-sm font-medium text-gray-700 mb-1">{t('mcp.scope')}</label>
          <select id="token-scope" value={tokenScope} onChange={(e) => {
            const val = e.target.value; if (val === 'read' || val === 'read-write') onScopeChange(val)
          }} className="w-full border rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500">
            <option value="read">{t('mcp.scopeRead')}</option>
            <option value="read-write">{t('mcp.scopeReadWrite')}</option>
          </select>
        </div>
        {error != null && error !== '' ? <div className="flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{error}</div> : null}
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{t('mcp.cancel')}</button>
          <button onClick={onSubmit} disabled={tokenName.trim() === '' || isCreating} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
            {isCreating ? t('mcp.generating') : t('mcp.generate')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP config snippet (inner content — wrapped by CollapsibleSection in parent)
// ---------------------------------------------------------------------------

interface McpConfigSnippetContentProps {
  readonly config: string
  readonly copied: boolean
  readonly onCopy: () => void
}

export function McpConfigSnippetContent({
  config, copied, onCopy,
}: McpConfigSnippetContentProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500">
          Add this to your <code className="bg-gray-100 px-1 rounded">mcp.json</code>. Replace <code className="bg-gray-100 px-1 rounded">&lt;YOUR_API_TOKEN&gt;</code> with a token from below.
        </p>
        <button onClick={onCopy} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 flex-shrink-0 ml-2">
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
          {copied ? t('mcp.copied') : t('mcp.copy')}
        </button>
      </div>
      <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs overflow-x-auto"><code>{config}</code></pre>
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

export function TokenRow({
  token, isDeleting, onDelete,
}: TokenRowProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <Key size={16} className="text-gray-400 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{token.name}</p>
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
            <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium', token.scope === 'read' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700')}>
              <Shield size={10} />{token.scope}
            </span>
            <span className="flex items-center gap-1"><Clock size={10} />{t('mcp.createdDate', { date: new Date(token.created_at).toLocaleDateString() })}</span>
            {token.last_used_at != null && token.last_used_at !== '' ? <span className="text-gray-400">{t('mcp.lastUsed', { date: new Date(token.last_used_at).toLocaleDateString() })}</span> : null}
          </div>
        </div>
      </div>
      <button onClick={onDelete} disabled={isDeleting} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50" title={t('mcp.revokeToken')}>
        <Trash2 size={16} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Token list content (inner content — wrapped by CollapsibleSection in parent)
// ---------------------------------------------------------------------------

interface TokenListContentProps {
  readonly tokens: ApiToken[]
  readonly isLoading: boolean
  readonly deletingTokenId: string | null
  readonly onDelete: (tokenId: string) => void
}

export function TokenListContent({
  tokens, isLoading, deletingTokenId, onDelete,
}: TokenListContentProps) {
  const { t } = useTranslation('projectDetail')
  if (isLoading) {
    return <p className="text-center text-gray-500 text-sm py-2">{t('mcp.loadingTokens')}</p>
  }
  if (tokens.length === 0) {
    return (
      <div className="text-center py-2">
        <Key size={28} className="mx-auto text-gray-300 mb-2" />
        <p className="text-gray-500 text-sm">{t('mcp.noTokensYet')}</p>
        <p className="text-gray-400 text-xs mt-1">{t('mcp.noTokensHint')}</p>
      </div>
    )
  }
  return (
    <div className="divide-y -mx-4">
      {tokens.map((token) => (
        <TokenRow key={token.token_id} token={token} isDeleting={deletingTokenId === token.token_id} onDelete={() => onDelete(token.token_id)} />
      ))}
    </div>
  )
}
