/**
 * @fileoverview The Connect page's `mcp.json` picker: one snippet per client. Claude Code, Cursor and
 * Kiro read the token from the `VOC_MCP_TOKEN` environment variable (the default, so a file that is
 * committed or shared carries no secret); "Other clients" is the paste-the-token variant.
 *
 * @module pages/Connect/McpJsonSnippets
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { buildClientMcpJson, MCP_CLIENTS, type McpClient, TOKEN_ENV_VAR, tokenExportLine } from './connectSnippets'
import { CopyButton } from './CopyButton'

function ClientPicker({ value, onChange }: Readonly<{ value: McpClient; onChange: (client: McpClient) => void }>) {
  const { t } = useTranslation('common')
  return (
    <div role="group" aria-label={t('connect.mcpClientLabel')} className="flex flex-wrap gap-1">
      {MCP_CLIENTS.map((client) => (
        <button key={client} type="button" aria-pressed={client === value} onClick={() => onChange(client)}
          className={client === value ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}>
          {t(`connect.mcpClient.${client}`)}
        </button>
      ))}
    </div>
  )
}

function EnvLine({ copiedKey, onCopy }: Readonly<{ copiedKey: string | null; onCopy: (text: string, key: string) => void }>) {
  const { t } = useTranslation('common')
  const line = tokenExportLine()
  return (
    <div className="space-y-1">
      <p className="text-[12px] text-muted">{t('connect.mcpEnvHint', { name: TOKEN_ENV_VAR })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-md bg-bg-hover px-2 py-1 text-[12px]" data-testid="connect-env-line">{line}</code>
        <CopyButton text={line} copyKey="envLine" copiedKey={copiedKey} onCopy={onCopy} />
      </div>
    </div>
  )
}

export function McpJsonSnippets({ endpointUrl }: Readonly<{ endpointUrl: string }>) {
  const { t } = useTranslation('common')
  const { copy, copiedKey } = useCopyToClipboard()
  const [client, setClient] = useState<McpClient>(MCP_CLIENTS[0])
  const mcpJson = buildClientMcpJson(endpointUrl, client)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-muted">{t('connect.mcpJsonLabel')}</p>
        <CopyButton text={mcpJson} copyKey="mcpJson" copiedKey={copiedKey} onCopy={copy} />
      </div>
      <ClientPicker value={client} onChange={setClient} />
      {/* Focusable and named: it scrolls sideways on a phone, and a scroll region
          with nothing focusable inside cannot be scrolled from the keyboard
          (axe scrollable-region-focusable, design audit). */}
      <pre tabIndex={0} role="region" aria-label={t('connect.mcpJsonLabel')} className="overflow-x-auto rounded-md bg-bg-hover p-3 text-[12px] focus-ring" data-testid="connect-mcp-json">{mcpJson}</pre>
      <p className="text-[12px] text-muted" data-testid="connect-mcp-file">{t(`connect.mcpFile.${client}`)}</p>
      {client === 'inline' ? <p className="text-[12px] text-muted">{t('connect.mcpJsonHint')}</p> : <EnvLine copiedKey={copiedKey} onCopy={copy} />}
    </div>
  )
}
