/**
 * @fileoverview The Connect page's "how to connect" card: the global MCP
 * endpoint URL, a ready `mcp.json` per client (McpJsonSnippets), and the skill (stable link + a download with
 * this deployment's endpoint filled in). None of them carries a real token.
 *
 * @module pages/Connect/EndpointCard
 */
import { Download, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { fillSkill, SKILL_FILE_NAME, SKILL_PATH, skillUrl } from './connectSnippets'
import { CopyButton } from './CopyButton'
import { McpJsonSnippets } from './McpJsonSnippets'

/** Fetch the static skill, fill in the endpoint, and save it as a file. */
async function downloadSkill(endpointUrl: string): Promise<void> {
  const response = await fetch(SKILL_PATH)
  if (!response.ok) throw new Error(`skill template: HTTP ${response.status}`)
  const blob = new Blob([fillSkill(await response.text(), endpointUrl)], { type: 'text/markdown' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = SKILL_FILE_NAME
  link.click()
  URL.revokeObjectURL(link.href)
}

export function EndpointCard({ endpointUrl }: Readonly<{ endpointUrl: string }>) {
  const { t } = useTranslation('common')
  const { copy, copiedKey } = useCopyToClipboard()
  const [downloadFailed, setDownloadFailed] = useState(false)
  const onDownload = () => {
    setDownloadFailed(false)
    downloadSkill(endpointUrl).catch(() => setDownloadFailed(true))
  }

  return (
    <section className="card space-y-4" aria-labelledby="connect-endpoint-title">
      <h2 id="connect-endpoint-title" className="text-base font-semibold text-text-strong">{t('connect.endpointTitle')}</h2>
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-muted">{t('connect.endpointLabel')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 min-w-0 break-all rounded-md bg-bg-hover px-2 py-1 text-[13px]" data-testid="connect-endpoint">{endpointUrl}</code>
          <CopyButton text={endpointUrl} copyKey="endpoint" copiedKey={copiedKey} onCopy={copy} />
        </div>
      </div>
      <McpJsonSnippets endpointUrl={endpointUrl} />
      <div className="space-y-2">
        <p className="text-[12px] font-medium text-muted">{t('connect.skillLabel')}</p>
        <p className="text-sm text-text">{t('connect.skillBody')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={onDownload}>
            <Download size={14} aria-hidden="true" /> {t('connect.downloadSkill')}
          </button>
          <a className="btn btn-secondary btn-sm" href={SKILL_PATH} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" /> {t('connect.openSkill')}
          </a>
          <CopyButton text={skillUrl(window.location.origin)} copyKey="skill" copiedKey={copiedKey} onCopy={copy} />
        </div>
        {downloadFailed && <p role="alert" className="text-[12px] text-danger">{t('connect.downloadFailed')}</p>}
      </div>
    </section>
  )
}
